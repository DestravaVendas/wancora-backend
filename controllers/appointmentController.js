
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { Logger } from '../utils/logger.js';
import { sessions } from '../services/baileys/connection.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Limpeza de telefone robusta (Garante DDI 55 se parecer número BR)
const cleanPhone = (phone) => {
    if (!phone) return null;
    let p = phone.replace(/\D/g, '');
    
    // Regra BR: Se tiver 10 (Fixo) ou 11 (Celular) dígitos e não começar com 55, adiciona.
    // Ex: 11999999999 -> 5511999999999
    if ((p.length === 10 || p.length === 11) && !p.startsWith('55')) {
        p = '55' + p;
    }
    return p;
};

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;

  try {
    if (!appointmentId || !companyId) return res.status(400).json({ error: "Dados incompletos." });

    // 1. Busca INSTÂNCIA CONECTADA (Sem tentar reconectar)
    // Confia no status do banco. Se diz que tá on, tenta usar.
    const { data: instance } = await supabase
        .from('instances')
        .select('session_id')
        .eq('company_id', companyId)
        .eq('status', 'connected')
        .order('updated_at', { ascending: false }) // Pega a mais recente se tiver duplicada
        .limit(1)
        .maybeSingle();

    if (!instance) {
        // Se não tem nada conectado, apenas loga e sai (O Worker pegará depois se conectar)
        Logger.warn('backend', `[AGENDA] Nenhuma sessão conectada para envio imediato.`, { appointmentId }, companyId);
        return res.json({ status: 'queued_no_session' });
    }

    const sessionId = instance.session_id;

    // 2. Busca DADOS DO AGENDAMENTO
    const { data: app } = await supabase
      .from('appointments')
      .select(`*, leads (name, phone), companies (name)`)
      .eq('id', appointmentId)
      .single();

    if (!app || app.confirmation_sent) {
        return res.json({ status: 'already_processed' });
    }

    // 3. Busca REGRAS DE NOTIFICAÇÃO
    // Pega qualquer regra ativa da empresa para ler a configuração global
    const { data: rule } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    const config = rule?.notification_config;
    
    if (!config) {
        Logger.info('backend', `[AGENDA] Sem configuração de notificação.`, {}, companyId);
        return res.json({ status: 'no_config' });
    }

    // 4. Prepara Variáveis
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

    // -> ENVIO PARA ADMIN
    if (config.admin_phone && config.admin_notifications) {
        const trigger = config.admin_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const phone = cleanPhone(config.admin_phone);
            if (phone) {
                tasks.push(
                    sendMessage({ 
                        sessionId, 
                        companyId, 
                        to: `${phone}@s.whatsapp.net`, 
                        type: 'text', 
                        content: replaceVars(trigger.template) 
                    }).catch(err => Logger.error('backend', 'Erro envio Admin', { error: err.message }))
                );
            }
        }
    }

    // -> ENVIO PARA LEAD
    if (app.leads?.phone && config.lead_notifications) {
        const trigger = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const phone = cleanPhone(app.leads.phone);
            if (phone) {
                tasks.push(
                    sendMessage({ 
                        sessionId, 
                        companyId, 
                        to: `${phone}@s.whatsapp.net`, 
                        type: 'text', 
                        content: replaceVars(trigger.template) 
                    }).catch(err => Logger.error('backend', 'Erro envio Lead', { error: err.message }))
                );
            }
        }
    }

    // 5. Executa Envios
    if (tasks.length > 0) {
        // Não usamos Promise.all para não falhar tudo se um falhar
        for (const task of tasks) await task;
        
        // Marca como enviado
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        
        Logger.info('backend', `[AGENDA] Confirmações enviadas (${tasks.length}).`, { appointmentId }, companyId);
        return res.json({ success: true, sent: tasks.length });
    }

    return res.json({ status: 'no_actions_needed' });

  } catch (error) {
    Logger.error('backend', `[AGENDA] Erro Crítico Controller`, { error: error.message }, companyId);
    return res.status(200).json({ error: error.message }); // 200 para não quebrar o client action
  }
};
