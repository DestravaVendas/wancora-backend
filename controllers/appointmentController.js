
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { Logger } from '../utils/logger.js';
import { sessions, startSession as startBaileysSession } from '../services/baileys/connection.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const formatPhoneForWhatsapp = (phone) => {
    if (!phone) return null;
    let clean = phone.replace(/\D/g, '');
    if (clean.length === 10 || clean.length === 11) {
        if (!clean.startsWith('55')) {
             clean = '55' + clean;
        }
    }
    return clean;
};

const delay = ms => new Promise(res => setTimeout(res, ms));

// Helper: Aguarda o socket estar pronto para envio
// Retorna a sessão válida ou lança erro
const waitForSocket = async (sessionId, companyId, maxRetries = 10) => {
    for (let i = 0; i < maxRetries; i++) {
        const session = sessions.get(sessionId);
        
        // Verifica se existe, se tem socket e se o websocket está ABERTO (readyState 1)
        if (session && session.sock && session.sock.ws && session.sock.ws.readyState === 1) {
            return session;
        }

        // Se a sessão não existe na memória, tenta iniciar (JIT)
        if (!session && i === 0) {
            Logger.warn('backend', `[AGENDA] Sessão ${sessionId} não encontrada na RAM. Tentando restaurar...`, {}, companyId);
            startBaileysSession(sessionId, companyId).catch(() => {});
        }
        
        Logger.info('backend', `[AGENDA] Aguardando conexão estável... (${i + 1}/${maxRetries})`, {}, companyId);
        await delay(2000); // Espera 2s
    }
    throw new Error("Timeout: WhatsApp não conectou a tempo para envio.");
};

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;
  let { sessionId } = req.body;
  
  Logger.info('backend', `[AGENDA] Requisicao recebida para Appt: ${appointmentId}`, { body: req.body }, companyId);

  try {
    if (!appointmentId) throw new Error('appointmentId é obrigatório.');

    const { data: app, error } = await supabase
      .from('appointments')
      .select(`*, leads (name, phone), companies (name)`)
      .eq('id', appointmentId)
      .single();

    if (error || !app) {
      Logger.error('backend', `[AGENDA] Agendamento não encontrado`, { error, appointmentId }, companyId);
      return res.status(404).json({ error: 'Agendamento não encontrado.' });
    }

    if (app.confirmation_sent) {
        return res.json({ message: "Já enviado anteriormente." });
    }

    // --- 1. RESOLUÇÃO DE SESSÃO ---
    if (!sessionId) {
      const { data: instance } = await supabase
        .from('instances')
        .select('session_id')
        .eq('company_id', app.company_id)
        .eq('status', 'connected') // Prefere conectados
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (instance) {
          sessionId = instance.session_id;
      } else {
          // Tenta pegar qualquer sessão (mesmo desconectada, para tentar acordar)
          const { data: anyInstance } = await supabase.from('instances').select('session_id').eq('company_id', app.company_id).limit(1).maybeSingle();
          sessionId = anyInstance?.session_id;
      }
    }

    if (!sessionId) {
         Logger.error('backend', `[AGENDA] Nenhuma instância encontrada para empresa.`, { companyId }, companyId);
         return res.status(503).json({ error: 'Nenhuma conexão WhatsApp disponível.' });
    }

    // --- 2. ESPERA ATIVA PELO SOCKET (Fix Conflito Stream) ---
    // Em vez de falhar imediatamente, esperamos a conexão estabilizar
    try {
        await waitForSocket(sessionId, app.company_id);
    } catch (socketError) {
        Logger.fatal('backend', `[AGENDA] Falha ao obter socket estável.`, { error: socketError.message }, companyId);
        return res.status(503).json({ error: "WhatsApp instável. Tente novamente em instantes." });
    }

    // --- 3. PREPARAÇÃO DA MENSAGEM ---
    const { data: rules } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('company_id', app.company_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    if (!rules?.notification_config) {
        Logger.warn('backend', `[AGENDA] Sem config de notificação.`, {}, companyId);
        return res.json({ message: "Sem configuração." });
    }

    const config = rules.notification_config;
    const tasks = [];

    const dateObj = new Date(app.start_time);
    const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
    const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
    
    const replaceVars = (tpl) => tpl
            .replace(/\[lead_name\]/g, app.leads?.name || 'Cliente')
            .replace(/\[lead_phone\]/g, app.leads?.phone || '')
            .replace(/\[empresa\]/g, app.companies?.name || 'Nossa Empresa')
            .replace(/\[data\]/g, dateStr)
            .replace(/\[hora\]/g, timeStr);

    // ADMIN
    if (config.admin_phone && config.admin_notifications) {
        const trigger = config.admin_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const msg = replaceVars(trigger.template);
            const phone = formatPhoneForWhatsapp(config.admin_phone);
            tasks.push(sendMessage({ sessionId, companyId: app.company_id, to: `${phone}@s.whatsapp.net`, type: 'text', content: msg }));
        }
    }

    // LEAD
    if (app.leads?.phone && config.lead_notifications) {
        const trigger = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const msg = replaceVars(trigger.template);
            const phone = formatPhoneForWhatsapp(app.leads.phone);
            tasks.push(sendMessage({ sessionId, companyId: app.company_id, to: `${phone}@s.whatsapp.net`, type: 'text', content: msg }));
        }
    }

    if (tasks.length > 0) {
        Logger.info('backend', `[AGENDA] Enviando ${tasks.length} mensagens...`, {}, companyId);
        await Promise.allSettled(tasks);
        
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        Logger.info('backend', `[AGENDA] Ciclo finalizado com sucesso.`, { appointmentId }, companyId);
        return res.status(200).json({ success: true });
    } else {
        Logger.info('backend', `[AGENDA] Nenhum trigger ativo encontrado.`, {}, companyId);
        return res.json({ message: "Nenhum envio necessário." });
    }

  } catch (error) {
    Logger.fatal('backend', `[AGENDA] Crash no controller`, { error: error.message, stack: error.stack }, companyId);
    return res.status(500).json({ error: error.message });
  }
};
