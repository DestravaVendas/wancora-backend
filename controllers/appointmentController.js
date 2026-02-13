
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
    // Se for formato local, adiciona DDI
    if (clean.length >= 10 && !clean.startsWith('55') && clean.length <= 11) {
         clean = '55' + clean;
    }
    return clean;
};

const delay = ms => new Promise(res => setTimeout(res, ms));

// Helper com Logs
const waitForSocket = async (sessionId, companyId, maxRetries = 20) => {
    // 1. Tenta recuperar sessão
    let session = sessions.get(sessionId);

    // 2. Se não existir, tenta iniciar (mas cuidado com loop)
    if (!session) {
        Logger.warn('backend', `[AGENDA] Sessão ${sessionId} não está em memória. Tentando boot...`, {}, companyId);
        try {
            await startBaileysSession(sessionId, companyId);
            await delay(5000); // Wait for boot
        } catch (e) {
            Logger.error('backend', `[AGENDA] Falha no boot forçado`, { error: e.message }, companyId);
        }
    }

    for (let i = 0; i < maxRetries; i++) {
        session = sessions.get(sessionId);
        if (session?.sock?.ws?.isOpen) {
            return session;
        }
        await delay(1000);
    }
    throw new Error("Socket Timeout: WhatsApp não conectou após 20s.");
};

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;
  let { sessionId } = req.body;
  
  // LOG INICIAL PARA MONITORAMENTO
  Logger.info('backend', `[AGENDA] Início Proc. Confirmação`, { appointmentId }, companyId);

  try {
    if (!appointmentId) throw new Error('appointmentId ausente.');

    // Busca Dados
    const { data: app, error } = await supabase
      .from('appointments')
      .select(`*, leads (name, phone), companies (name)`)
      .eq('id', appointmentId)
      .single();

    if (error || !app) {
      Logger.error('backend', `[AGENDA] Agendamento não encontrado`, { error: error?.message }, companyId);
      return res.status(404).json({ error: 'Not found' });
    }

    if (app.confirmation_sent) {
        return res.json({ message: "Já enviado anteriormente." });
    }

    // RESOLUÇÃO DE SESSÃO
    if (!sessionId) {
      const { data: instance } = await supabase
        .from('instances')
        .select('session_id')
        .eq('company_id', app.company_id)
        .eq('status', 'connected') // Prioriza conectadas
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (instance) {
          sessionId = instance.session_id;
      } else {
          // Fallback: Pega qualquer uma
           const { data: anyInst } = await supabase
            .from('instances')
            .select('session_id')
            .eq('company_id', app.company_id)
            .limit(1)
            .maybeSingle();
           sessionId = anyInst?.session_id;
      }
    }

    if (!sessionId) {
         Logger.error('backend', `[AGENDA] Falha: Nenhuma sessão WhatsApp cadastrada`, {}, companyId);
         return res.status(503).json({ error: 'No WhatsApp session found' });
    }

    // SOCKET CHECK
    try {
        await waitForSocket(sessionId, app.company_id);
    } catch (socketError) {
        Logger.error('backend', `[AGENDA] Socket Indisponível - Mensagem será enviada pelo Worker depois.`, { error: socketError.message }, companyId);
        // Retorna sucesso para o frontend não travar, mas loga o erro. O Worker pegará depois pois confirmation_sent ainda é false.
        return res.json({ warning: "Socket indisponível, agendado para retry via Worker." });
    }

    // MONTAGEM MENSAGEM
    const { data: rules } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('company_id', app.company_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    if (!rules?.notification_config) {
        Logger.warn('backend', `[AGENDA] Sem config de notificação`, {}, companyId);
        return res.json({ message: "Sem config" });
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

    // ADMIN NOTICE
    if (config.admin_phone && config.admin_notifications) {
        const trigger = config.admin_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const msg = replaceVars(trigger.template);
            const phone = formatPhoneForWhatsapp(config.admin_phone);
            if (phone) {
                Logger.info('backend', `[AGENDA] Enviando para Admin`, { phone }, companyId);
                tasks.push(sendMessage({ sessionId, companyId: app.company_id, to: `${phone}@s.whatsapp.net`, type: 'text', content: msg }));
            }
        }
    }

    // LEAD CONFIRMATION
    if (app.leads?.phone && config.lead_notifications) {
        const trigger = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const msg = replaceVars(trigger.template);
            const phone = formatPhoneForWhatsapp(app.leads.phone);
            if (phone) {
                Logger.info('backend', `[AGENDA] Enviando para Lead`, { phone }, companyId);
                tasks.push(sendMessage({ sessionId, companyId: app.company_id, to: `${phone}@s.whatsapp.net`, type: 'text', content: msg }));
            }
        }
    }

    if (tasks.length > 0) {
        await Promise.all(tasks);
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        Logger.info('backend', `[AGENDA] Sucesso Total: ${tasks.length} msgs enviadas.`, {}, companyId);
        return res.status(200).json({ success: true });
    } else {
        Logger.info('backend', `[AGENDA] Nenhuma msg configurada para enviar.`, {}, companyId);
        return res.json({ message: "Nenhum trigger ativo" });
    }

  } catch (error) {
    Logger.error('backend', `[AGENDA] Erro Crítico no Controller`, { error: error.message, stack: error.stack }, companyId);
    return res.status(500).json({ error: error.message });
  }
};
