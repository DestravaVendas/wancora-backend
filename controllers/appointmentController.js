
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { Logger } from '../utils/logger.js';
import { sessions, startSession } from '../services/baileys/connection.js';

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
  const TRACE_ID = `APP-${appointmentId?.slice(0,4)}`; // ID curto para logs

  try {
    console.log(`[${TRACE_ID}] 🚀 Iniciando fluxo de notificação.`);

    if (!appointmentId || !companyId) {
        console.error(`[${TRACE_ID}] ❌ Dados incompletos.`);
        return res.status(400).json({ error: "Dados incompletos." });
    }

    // 1. DELAY DE CONSISTÊNCIA
    // Espera 3s para garantir que a transação do banco (insert appointment) propagou
    await sleep(3000);

    // 2. BUSCA CONFIGURAÇÃO DA REGRA
    // Precisamos saber qual regra gerou isso para pegar os templates
    const { data: app } = await supabase
      .from('appointments')
      .select(`*, leads (name, phone), companies (name)`)
      .eq('id', appointmentId)
      .single();

    if (!app) {
        console.error(`[${TRACE_ID}] ❌ Agendamento não encontrado no banco.`);
        return res.json({ status: 'appointment_not_found' });
    }

    if (app.confirmation_sent) {
        console.log(`[${TRACE_ID}] ℹ️ Confirmação já enviada anteriormente.`);
        return res.json({ status: 'already_sent' });
    }

    // Busca a regra de disponibilidade (que contem o config de notificação)
    // Nota: O appointment não tem FK direta pra rule, mas podemos inferir ou pegar a regra geral do usuário/empresa
    // Para simplificar, pegamos a primeira regra ativa que tenha config, ou buscamos pelo user_id se tiver
    let query = supabase.from('availability_rules').select('notification_config').eq('company_id', companyId).eq('is_active', true);
    if (app.user_id) query = query.eq('user_id', app.user_id);
    
    const { data: rules } = await query.limit(1);
    const config = rules?.[0]?.notification_config;
    
    if (!config) {
        console.warn(`[${TRACE_ID}] ⚠️ Nenhuma regra de notificação ativa encontrada.`);
        return res.json({ status: 'no_config' });
    }

    // 3. SELEÇÃO DE SESSÃO COM AUTO-HEAL E SMART ROUTING
    let activeSessionId = null;
    
    // A. Tenta sessão específica configurada no JSON
    if (config.sending_session_id) {
        const session = sessions.get(config.sending_session_id);
        if (session?.sock) {
            activeSessionId = config.sending_session_id;
            console.log(`[${TRACE_ID}] ✅ Usando sessão configurada: ${activeSessionId}`);
        } else {
             console.warn(`[${TRACE_ID}] ⚠️ Sessão configurada ${config.sending_session_id} offline na RAM.`);
        }
    }

    // B. Fallback Inteligente (Busca qualquer conectada)
    if (!activeSessionId) {
        const { data: dbInstances } = await supabase
            .from('instances')
            .select('session_id')
            .eq('company_id', companyId)
            .eq('status', 'connected');

        if (dbInstances && dbInstances.length > 0) {
            // Tenta encontrar uma que esteja viva na RAM
            for (const inst of dbInstances) {
                const s = sessions.get(inst.session_id);
                if (s?.sock) {
                    activeSessionId = inst.session_id;
                    console.log(`[${TRACE_ID}] ✅ Usando sessão fallback (Smart Routing): ${activeSessionId}`);
                    break;
                }
            }
        }
    }

    if (!activeSessionId) {
        await Logger.error('backend', `[AGENDA] Nenhuma sessão disponível para envio.`, { appointmentId }, companyId);
        return res.json({ status: 'sessions_offline' });
    }

    // 5. Preparação das Mensagens
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

    // -> ADMIN NOTIFICATION
    if (config.admin_phone && config.admin_notifications) {
        const trigger = config.admin_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const phone = cleanPhone(config.admin_phone);
            if (phone) {
                console.log(`[${TRACE_ID}] 📤 Preparando envio Admin (${phone})...`);
                tasks.push(
                    sendMessage({ 
                        sessionId: activeSessionId, 
                        companyId, 
                        to: `${phone}@s.whatsapp.net`, 
                        type: 'text', 
                        content: replaceVars(trigger.template) 
                    }).catch(err => {
                        console.error(`[${TRACE_ID}] Erro Admin:`, err.message);
                        Logger.error('backend', 'Erro envio Admin', { error: err.message }, companyId);
                    })
                );
            }
        }
    }

    // -> LEAD NOTIFICATION
    if (app.leads?.phone && config.lead_notifications) {
        const trigger = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const phone = cleanPhone(app.leads.phone);
            if (phone) {
                console.log(`[${TRACE_ID}] 📤 Preparando envio Lead (${phone})...`);
                tasks.push(
                    sendMessage({ 
                        sessionId: activeSessionId, 
                        companyId, 
                        to: `${phone}@s.whatsapp.net`, 
                        type: 'text', 
                        content: replaceVars(trigger.template) 
                    }).catch(err => {
                        console.error(`[${TRACE_ID}] Erro Lead:`, err.message);
                        Logger.error('backend', 'Erro envio Lead', { error: err.message }, companyId);
                    })
                );
            }
        }
    }

    // 6. Disparo
    if (tasks.length > 0) {
        await Promise.all(tasks);
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        
        console.log(`[${TRACE_ID}] ✨ Sucesso! Mensagens entregues.`);
        return res.json({ success: true, sent: tasks.length });
    }

    return res.json({ status: 'no_actions_needed' });

  } catch (error) {
    console.error(`[APP-ERROR] ❌`, error);
    return res.status(500).json({ error: error.message });
  }
};
