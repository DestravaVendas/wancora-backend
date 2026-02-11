
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { normalizeJid } from '../utils/wppParsers.js';
import { Logger } from '../utils/logger.js';
import { sessions, startSession as startBaileysSession } from '../services/baileys/connection.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Helper de Limpeza e Formatação BR
const formatPhoneForWhatsapp = (phone) => {
    if (!phone) return null;
    let clean = phone.replace(/\D/g, '');
    if (clean.length === 10 || clean.length === 11) {
        clean = '55' + clean;
    }
    return clean;
};

// Helper de espera
const delay = ms => new Promise(res => setTimeout(res, ms));

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;
  let { sessionId } = req.body;
  
  try {
    Logger.info('backend', `[AGENDA] Iniciando confirmação`, { appointmentId, companyId }, companyId);

    if (!appointmentId) {
        throw new Error('appointmentId é obrigatório.');
    }

    // 1. Buscar dados do agendamento
    const { data: app, error } = await supabase
      .from('appointments')
      .select(`
        *,
        leads (name, phone),
        companies (name)
      `)
      .eq('id', appointmentId)
      .single();

    if (error || !app) {
      Logger.error('backend', `[AGENDA] Agendamento não encontrado`, { error, appointmentId }, companyId);
      return res.status(404).json({ error: 'Agendamento não encontrado.' });
    }
    
    if (app.confirmation_sent) {
        Logger.warn('backend', `[AGENDA] Confirmação já enviada anteriormente`, { appointmentId }, companyId);
        return res.json({ message: "Já enviado." });
    }

    // 2. Resolução Inteligente de Sessão (JIT Restore)
    if (!sessionId) {
      const { data: instance } = await supabase
        .from('instances')
        .select('session_id, status')
        .eq('company_id', app.company_id)
        .eq('status', 'connected')
        .limit(1)
        .maybeSingle();

      if (instance) {
          sessionId = instance.session_id;
          
          // CHECK DE MEMÓRIA (A "Sessão Zumbi")
          let memorySession = sessions.get(sessionId);
          
          if (!memorySession) {
              Logger.warn('baileys', `[AGENDA] Sessão ${sessionId} ZUMBI detectada. Tentando ressuscitar...`, { appointmentId }, companyId);
              
              // Tenta reconectar na hora
              try {
                  await startBaileysSession(sessionId, app.company_id);
                  // Espera 5 segundos para o socket subir
                  await delay(5000);
                  
                  // Verifica de novo
                  memorySession = sessions.get(sessionId);
                  if (!memorySession) {
                       throw new Error("Falha na auto-recuperação da sessão.");
                  }
                  Logger.info('baileys', `[AGENDA] Sessão ressuscitada com sucesso!`, { sessionId }, companyId);
              } catch (restoreError) {
                   Logger.fatal('baileys', `[AGENDA] Falha fatal ao restaurar sessão para envio.`, { error: restoreError.message }, companyId);
                   return res.status(503).json({ error: 'Erro crítico: Instância Zumbi. Reinício falhou.' });
              }
          }
      } else {
          Logger.error('backend', `[AGENDA] Nenhuma instância conectada encontrada para empresa.`, { companyId }, companyId);
          return res.status(503).json({ error: 'Nenhuma conexão WhatsApp disponível.' });
      }
    }

    // 3. Buscar Regras de Notificação
    const { data: rules } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('company_id', app.company_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    if (!rules?.notification_config) {
        return res.json({ message: "Sem regras configuradas." });
    }

    const config = rules.notification_config;
    const tasks = [];

    // Preparar Variáveis
    const dateObj = new Date(app.start_time);
    const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
    const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
    
    const replaceVars = (tpl) => {
        return tpl
            .replace(/\[lead_name\]/g, app.leads?.name || 'Cliente')
            .replace(/\[lead_phone\]/g, app.leads?.phone || '')
            .replace(/\[empresa\]/g, app.companies?.name || 'Nossa Empresa')
            .replace(/\[data\]/g, dateStr)
            .replace(/\[hora\]/g, timeStr);
    };

    // A. Notificar Admin
    if (config.admin_phone && config.admin_notifications) {
        const onBookingAdmin = config.admin_notifications.find(n => n.type === 'on_booking' && n.active);
        
        if (onBookingAdmin) {
            const adminMsg = replaceVars(onBookingAdmin.template);
            const adminPhone = formatPhoneForWhatsapp(config.admin_phone);
            const adminJid = `${adminPhone}@s.whatsapp.net`;
            
            tasks.push(
                sendMessage({ 
                    sessionId, 
                    companyId: app.company_id,
                    to: adminJid, 
                    type: 'text', 
                    content: adminMsg 
                })
                .catch(e => {
                    Logger.error('backend', `[AGENDA] Falha envio Admin`, { to: adminJid, error: e.message }, companyId);
                    throw e;
                })
            );
        }
    }

    // B. Notificar Lead
    if (app.leads?.phone && config.lead_notifications) {
        const onBookingLead = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        
        if (onBookingLead) {
            const leadMsg = replaceVars(onBookingLead.template);
            const leadPhone = formatPhoneForWhatsapp(app.leads.phone);
            const leadJid = `${leadPhone}@s.whatsapp.net`;
            
            tasks.push(
                sendMessage({ 
                    sessionId, 
                    companyId: app.company_id,
                    to: leadJid, 
                    type: 'text', 
                    content: leadMsg 
                })
                .catch(e => {
                    Logger.error('backend', `[AGENDA] Falha envio Lead`, { to: leadJid, error: e.message }, companyId);
                    throw e;
                })
            );
        }
    }

    // 4. Executar Envios
    if (tasks.length > 0) {
        const results = await Promise.allSettled(tasks);
        const rejected = results.filter(r => r.status === 'rejected');
        
        if (rejected.length > 0) {
             throw new Error(`Falha em ${rejected.length} envios.`);
        }

        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        Logger.info('backend', `[AGENDA] Confirmações enviadas com sucesso.`, { appointmentId }, companyId);
    } 

    return res.status(200).json({ success: true });

  } catch (error) {
    Logger.fatal('backend', `[AGENDA] Erro Fatal no Controller`, { error: error.message }, companyId);
    return res.status(500).json({ error: error.message });
  }
};
