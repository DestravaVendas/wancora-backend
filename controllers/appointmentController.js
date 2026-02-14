
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { Logger } from '../utils/logger.js';
import { sessions } from '../services/baileys/connection.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const cleanPhone = (phone) => {
    if (!phone) return null;
    let p = phone.replace(/\D/g, '');
    if ((p.length === 10 || p.length === 11) && !p.startsWith('55')) {
        p = '55' + p;
    }
    return p;
};

// Pequeno delay promessificado
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;

  try {
    if (!appointmentId || !companyId) return res.status(400).json({ error: "Dados incompletos." });

    // 1. DELAY DE CONSISTÊNCIA
    await sleep(2000);

    // 2. BUSCA REGRAS DE NOTIFICAÇÃO (CRÍTICO: Precisamos da config para saber QUAL SESSÃO usar)
    const { data: rule } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    const config = rule?.notification_config;
    
    if (!config) {
        return res.json({ status: 'no_config' });
    }

    // 3. SELEÇÃO DE SESSÃO INTELIGENTE (Prioritária)
    let activeSessionId = null;

    // A. Verifica se o usuário escolheu uma sessão específica
    if (config.sending_session_id) {
        const specificSession = sessions.get(config.sending_session_id);
        if (specificSession && specificSession.sock) {
            console.log(`[AGENDA] Usando sessão prioritária configurada: ${config.sending_session_id}`);
            activeSessionId = config.sending_session_id;
        } else {
             console.warn(`[AGENDA] Sessão configurada ${config.sending_session_id} está offline. Tentando fallback...`);
        }
    }

    // B. Fallback (Smart Routing): Se não configurou ou está offline, busca qualquer uma
    if (!activeSessionId) {
        const { data: instances } = await supabase
            .from('instances')
            .select('session_id')
            .eq('company_id', companyId)
            .eq('status', 'connected');

        if (instances && instances.length > 0) {
            for (const inst of instances) {
                const session = sessions.get(inst.session_id);
                if (session && session.sock) {
                    activeSessionId = inst.session_id;
                    break;
                }
            }
        }
    }

    if (!activeSessionId) {
        await Logger.error('backend', `[AGENDA] Nenhuma sessão disponível para envio.`, { appointmentId }, companyId);
        return res.json({ status: 'sessions_offline' });
    }

    // 4. Busca Dados do Agendamento
    const { data: app } = await supabase
      .from('appointments')
      .select(`*, leads (name, phone), companies (name)`)
      .eq('id', appointmentId)
      .single();

    if (!app) return res.json({ status: 'appointment_not_found' });
    if (app.confirmation_sent) return res.json({ status: 'already_sent' });

    // 5. Prepara Variáveis
    const dateObj = new Date(app.start_time);
    const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
    const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
    
    const replaceVars = (tpl) => {
        if (!tpl) return "";
        return tpl
            .replace(/\[lead_name\]/g, app.leads?.name || 'Cliente')
            .replace(/\[lead_phone\]/g, app.leads?.phone || '')
            .replace(/\[empresa\]/g, app.companies?.name || 'Nossa Empresa')
            .replace(/\[data\]/g, dateStr)
            .replace(/\[hora\]/g, timeStr);
    };

    const tasks = [];

    // -> ADMIN
    if (config.admin_phone && config.admin_notifications) {
        const trigger = config.admin_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const phone = cleanPhone(config.admin_phone);
            if (phone) {
                tasks.push(
                    sendMessage({ 
                        sessionId: activeSessionId, 
                        companyId, 
                        to: `${phone}@s.whatsapp.net`, 
                        type: 'text', 
                        content: replaceVars(trigger.template) 
                    }).catch(err => Logger.error('backend', 'Erro envio Admin', { error: err.message }, companyId))
                );
            }
        }
    }

    // -> LEAD
    if (app.leads?.phone && config.lead_notifications) {
        const trigger = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const phone = cleanPhone(app.leads.phone);
            if (phone) {
                tasks.push(
                    sendMessage({ 
                        sessionId: activeSessionId, 
                        companyId, 
                        to: `${phone}@s.whatsapp.net`, 
                        type: 'text', 
                        content: replaceVars(trigger.template) 
                    }).catch(err => Logger.error('backend', 'Erro envio Lead', { error: err.message }, companyId))
                );
            }
        }
    }

    // 6. Executa
    if (tasks.length > 0) {
        await Promise.all(tasks);
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        
        await Logger.info('backend', `[AGENDA] ${tasks.length} confirmações enviadas via ${activeSessionId}.`, { appointmentId }, companyId);
        return res.json({ success: true, sent: tasks.length });
    }

    return res.json({ status: 'no_actions_needed' });

  } catch (error) {
    Logger.error('backend', `[AGENDA] Erro Crítico Controller`, { error: error.message }, companyId);
    return res.status(200).json({ error: error.message });
  }
};
