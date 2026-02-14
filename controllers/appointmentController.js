
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { Logger } from '../utils/logger.js';
import { sessions } from '../services/baileys/connection.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Helper simples para limpar telefone
const cleanPhone = (phone) => {
    if (!phone) return null;
    let p = phone.replace(/\D/g, '');
    if ((p.length === 10 || p.length === 11) && !p.startsWith('55')) {
        p = '55' + p;
    }
    return p;
};

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;

  try {
    // 1. Validação Básica
    if (!appointmentId || !companyId) return res.status(400).json({ error: "Dados incompletos." });

    console.log(`[AGENDA] Tentativa de envio para AppID: ${appointmentId}`);

    // 2. BUSCA SESSÃO NA MEMÓRIA (CRÍTICO: SEM TENTATIVA DE CONEXÃO)
    // Primeiro, descobrimos qual é a sessão ativa dessa empresa no banco
    const { data: instance } = await supabase
        .from('instances')
        .select('session_id')
        .eq('company_id', companyId)
        .eq('status', 'connected')
        .limit(1)
        .maybeSingle();

    if (!instance) {
        console.warn(`[AGENDA] Nenhuma instância 'connected' no banco para empresa ${companyId}. Ignorando.`);
        return res.json({ status: 'skipped_no_db_session' });
    }

    const sessionId = instance.session_id;
    const session = sessions.get(sessionId);

    // SE NÃO TIVER NA MEMÓRIA, NÃO TENTA RECONECTAR.
    // Isso evita o "Conflito de Stream" (Erro 440)
    if (!session || !session.sock) {
         console.warn(`[AGENDA] Sessão ${sessionId} está no banco mas NÃO está na memória RAM. O Bot pode estar reiniciando.`);
         // Retorna 200 para não travar o frontend
         return res.json({ status: 'skipped_session_offline' });
    }

    // 3. Busca Dados do Agendamento
    const { data: app } = await supabase
      .from('appointments')
      .select(`
        *, 
        leads (name, phone), 
        companies (name)
      `)
      .eq('id', appointmentId)
      .single();

    if (!app || app.confirmation_sent) {
        return res.json({ status: 'already_processed_or_not_found' });
    }

    // 4. Busca Regras de Notificação
    const { data: rules } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    const config = rules?.notification_config;
    if (!config) return res.json({ status: 'no_config' });

    // 5. Prepara Templates
    const dateObj = new Date(app.start_time);
    const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
    const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
    
    const replaceVars = (tpl) => tpl
            .replace(/\[lead_name\]/g, app.leads?.name || 'Cliente')
            .replace(/\[lead_phone\]/g, app.leads?.phone || '')
            .replace(/\[empresa\]/g, app.companies?.name || 'Nossa Empresa')
            .replace(/\[data\]/g, dateStr)
            .replace(/\[hora\]/g, timeStr);

    const tasks = [];

    // -> Envio ADMIN
    if (config.admin_phone && config.admin_notifications) {
        const trigger = config.admin_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const phone = cleanPhone(config.admin_phone);
            tasks.push(sendMessage({ 
                sessionId, 
                companyId, 
                to: `${phone}@s.whatsapp.net`, 
                type: 'text', 
                content: replaceVars(trigger.template) 
            }).catch(err => console.error('[AGENDA] Erro envio Admin:', err.message)));
        }
    }

    // -> Envio LEAD
    if (app.leads?.phone && config.lead_notifications) {
        const trigger = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const phone = cleanPhone(app.leads.phone);
            tasks.push(sendMessage({ 
                sessionId, 
                companyId, 
                to: `${phone}@s.whatsapp.net`, 
                type: 'text', 
                content: replaceVars(trigger.template) 
            }).catch(err => console.error('[AGENDA] Erro envio Lead:', err.message)));
        }
    }

    // 6. Executa e Marca
    if (tasks.length > 0) {
        await Promise.all(tasks);
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        console.log(`[AGENDA] ${tasks.length} avisos enviados.`);
        return res.json({ success: true, count: tasks.length });
    }

    return res.json({ status: 'no_actions' });

  } catch (error) {
    console.error('[AGENDA] Erro Fatal Controller:', error);
    // Retorna 200 com erro no body para não quebrar fluxo do frontend
    return res.status(200).json({ error: error.message });
  }
};
