
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
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
        // Assume BR se não tiver DDI
        if (!clean.startsWith('55')) {
             clean = '55' + clean;
        }
    }
    return clean;
};

// Helper de espera
const delay = ms => new Promise(res => setTimeout(res, ms));

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;
  let { sessionId } = req.body;
  
  try {
    Logger.info('backend', `[AGENDA] Iniciando processo de confirmação`, { appointmentId, companyId }, companyId);

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
      Logger.error('backend', `[AGENDA] Agendamento não encontrado no banco`, { error, appointmentId }, companyId);
      return res.status(404).json({ error: 'Agendamento não encontrado.' });
    }
    
    // DEBUG: Verifica se já foi enviado
    if (app.confirmation_sent) {
        Logger.warn('backend', `[AGENDA] Confirmação ignorada: Já marcada como enviada`, { appointmentId }, companyId);
        // Não retorna erro para o frontend não achar que falhou, apenas avisa que já foi
        return res.json({ message: "Já enviado anteriormente." });
    }

    // 2. Resolução de Sessão
    if (!sessionId) {
      // Busca qualquer sessão conectada da empresa
      const { data: instance } = await supabase
        .from('instances')
        .select('session_id, status')
        .eq('company_id', app.company_id)
        .eq('status', 'connected')
        .order('updated_at', { ascending: false }) // Pega a mais recente
        .limit(1)
        .maybeSingle();

      if (instance) {
          sessionId = instance.session_id;
          
          // CHECK DE MEMÓRIA (Zombie Check)
          let memorySession = sessions.get(sessionId);
          
          if (!memorySession) {
              Logger.warn('baileys', `[AGENDA] Sessão ${sessionId} consta como conectada no DB mas não está na memória. Tentando restaurar...`, { appointmentId }, companyId);
              
              try {
                  await startBaileysSession(sessionId, app.company_id);
                  await delay(5000); // Espera 5s para conexão subir
                  
                  memorySession = sessions.get(sessionId);
                  if (!memorySession) {
                       throw new Error("Falha na auto-recuperação da sessão Zumbi.");
                  }
                  Logger.info('baileys', `[AGENDA] Sessão restaurada com sucesso!`, { sessionId }, companyId);
              } catch (restoreError) {
                   Logger.fatal('baileys', `[AGENDA] Falha fatal ao restaurar sessão.`, { error: restoreError.message }, companyId);
                   return res.status(503).json({ error: 'Erro crítico: WhatsApp desconectado no servidor.' });
              }
          }
      } else {
          Logger.error('backend', `[AGENDA] Nenhuma instância conectada disponível para envio.`, { companyId }, companyId);
          return res.status(503).json({ error: 'Nenhuma conexão WhatsApp disponível.' });
      }
    }

    // 3. Buscar Regras
    const { data: rules } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('company_id', app.company_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    if (!rules?.notification_config) {
        Logger.warn('backend', `[AGENDA] Sem regras de notificação configuradas para esta empresa.`, { companyId }, companyId);
        return res.json({ message: "Sem configuração de notificação." });
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
            
            Logger.info('backend', `[AGENDA] Preparando envio para Admin`, { to: adminJid }, companyId);

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
                    // Não lança erro para não impedir o envio ao lead
                    return { error: e.message }; 
                })
            );
        } else {
            Logger.info('backend', `[AGENDA] Admin configurado mas sem trigger 'on_booking' ativo.`, {}, companyId);
        }
    } else {
        Logger.info('backend', `[AGENDA] Telefone Admin não configurado.`, {}, companyId);
    }

    // B. Notificar Lead
    if (app.leads?.phone && config.lead_notifications) {
        const onBookingLead = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        
        if (onBookingLead) {
            const leadMsg = replaceVars(onBookingLead.template);
            const leadPhone = formatPhoneForWhatsapp(app.leads.phone);
            const leadJid = `${leadPhone}@s.whatsapp.net`;
            
            Logger.info('backend', `[AGENDA] Preparando envio para Lead`, { to: leadJid }, companyId);

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
                    return { error: e.message };
                })
            );
        } else {
             Logger.info('backend', `[AGENDA] Lead existe mas sem trigger 'on_booking' ativo.`, {}, companyId);
        }
    } else {
         Logger.warn('backend', `[AGENDA] Lead sem telefone ou config de notificação ausente.`, { lead: app.leads }, companyId);
    }

    // 4. Executar Envios
    if (tasks.length > 0) {
        const results = await Promise.all(tasks);
        // Verifica se algum falhou
        const failures = results.filter(r => r && r.error);
        
        if (failures.length === tasks.length) {
             throw new Error(`Todas as tentativas de envio falharam. Ex: ${failures[0].error}`);
        }

        // Marca como enviado se pelo menos um funcionou
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        Logger.info('backend', `[AGENDA] Processo finalizado. ${results.length - failures.length} enviados com sucesso.`, { appointmentId }, companyId);
        
        return res.status(200).json({ success: true, sent: results.length - failures.length });
    } else {
        Logger.info('backend', `[AGENDA] Nenhuma tarefa de envio foi gerada (Verifique triggers ativos).`, { config }, companyId);
        return res.json({ message: "Nenhum envio necessário com a config atual." });
    }

  } catch (error) {
    Logger.fatal('backend', `[AGENDA] Erro Fatal no Controller`, { error: error.message, stack: error.stack }, companyId);
    return res.status(500).json({ error: error.message });
  }
};
