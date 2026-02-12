
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

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;
  let { sessionId } = req.body;
  
  // LOG EXPLÍCITO: Quero saber que o request chegou
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

    // --- 1. RESOLUÇÃO DE SESSÃO COM AUTO-CURA (JIT) ---
    if (!sessionId) {
      const { data: instance } = await supabase
        .from('instances')
        .select('session_id, status')
        .eq('company_id', app.company_id)
        .eq('status', 'connected')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (instance) {
          sessionId = instance.session_id;
          
          // VERIFICAÇÃO CRÍTICA DE MEMÓRIA
          const memorySession = sessions.get(sessionId);
          
          if (!memorySession || !memorySession.sock) {
              Logger.warn('backend', `[AGENDA] SESSÃO ZUMBI DETECTADA! ${sessionId} consta no DB mas não na RAM. Iniciando Auto-Cura...`, {}, companyId);
              
              // Tenta reviver a sessão AGORA
              try {
                  await startBaileysSession(sessionId, app.company_id);
                  Logger.info('backend', `[AGENDA] Auto-Cura: Processo de reconexão iniciado. Aguardando socket...`, {}, companyId);
                  
                  // Espera 5 segundos para o socket subir e autenticar
                  await delay(5000); 
                  
                  // Verifica de novo
                  if (!sessions.get(sessionId)) {
                      throw new Error("Falha na Auto-Cura: Sessão não subiu a tempo.");
                  }
                  Logger.info('backend', `[AGENDA] Auto-Cura: SUCESSO! Sessão ${sessionId} online para envio.`, {}, companyId);
              } catch (restoreErr) {
                  Logger.fatal('backend', `[AGENDA] Auto-Cura FALHOU.`, { error: restoreErr.message }, companyId);
                  return res.status(503).json({ error: "Erro crítico de infraestrutura: WhatsApp offline." });
              }
          }
      } else {
          Logger.error('backend', `[AGENDA] Nenhuma sessão conectada encontrada.`, { companyId }, companyId);
          return res.status(503).json({ error: 'Nenhuma conexão WhatsApp disponível.' });
      }
    }

    // --- 2. PREPARAÇÃO DA MENSAGEM ---
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
        await Promise.allSettled(tasks); // Usa settled para não falhar se um der erro
        
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
