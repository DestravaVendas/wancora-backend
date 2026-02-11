
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { normalizeJid } from '../utils/wppParsers.js';
import { Logger } from '../utils/logger.js'; // Integração com System Logger
import { sessions } from '../services/baileys/connection.js'; // Para check de memória real

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Helper de Limpeza e Formatação BR
const formatPhoneForWhatsapp = (phone) => {
    if (!phone) return null;
    let clean = phone.replace(/\D/g, '');
    // Se não tiver DDI (comprimento 10 ou 11), assume Brasil (55)
    if (clean.length === 10 || clean.length === 11) {
        clean = '55' + clean;
    }
    return clean;
};

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;
  let { sessionId } = req.body;
  
  // ID de rastreamento para o Log
  const traceId = `app-${appointmentId?.slice(0, 8)}`;

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
    
    // Validação de Duplicidade
    if (app.confirmation_sent) {
        Logger.warn('backend', `[AGENDA] Confirmação já enviada anteriormente`, { appointmentId }, companyId);
        // Não retorna erro para não quebrar fluxo do frontend, mas avisa
        return res.json({ message: "Já enviado." });
    }

    // 2. Resolução Inteligente de Sessão (Check de Memória Real)
    if (!sessionId) {
      // Busca no banco qual deveria estar conectada
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
          const memorySession = sessions.get(sessionId);
          if (!memorySession) {
              Logger.fatal('baileys', `[AGENDA] Sessão ${sessionId} consta como ONLINE no banco, mas não está na memória RAM. Reinício necessário.`, { appointmentId }, companyId);
              return res.status(503).json({ error: 'Erro crítico: Instância Zumbi. Reinicie a conexão.' });
          }
      } else {
          Logger.error('backend', `[AGENDA] Nenhuma instância conectada encontrada para empresa.`, { companyId }, companyId);
          return res.status(503).json({ error: 'Nenhuma conexão WhatsApp disponível.' });
      }
    }

    // 3. Buscar Regras de Notificação
    const { data: rules } = await supabase
        .from('availability_rules')
        .select('notification_config, slug')
        .eq('company_id', app.company_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    if (!rules?.notification_config) {
        Logger.warn('backend', `[AGENDA] Sem regras de notificação configuradas.`, { companyId }, companyId);
        return res.json({ message: "Sem regras." });
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
                .then(() => Logger.info('backend', `[AGENDA] Admin notificado`, { to: adminJid }, companyId))
                .catch(e => {
                    Logger.error('backend', `[AGENDA] Falha envio Admin`, { to: adminJid, error: e.message }, companyId);
                    throw e; // Relança para saber que falhou
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
                .then(() => Logger.info('backend', `[AGENDA] Lead notificado`, { to: leadJid }, companyId))
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

        // 5. Marcar confirmação como enviada
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        
        Logger.info('backend', `[AGENDA] Processo finalizado com sucesso.`, { appointmentId }, companyId);
    } else {
        Logger.info('backend', `[AGENDA] Nenhuma notificação configurada para enviar.`, { appointmentId }, companyId);
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    Logger.fatal('backend', `[AGENDA] Erro Fatal no Controller`, { error: error.message, stack: error.stack }, companyId);
    return res.status(500).json({ error: error.message });
  }
};
