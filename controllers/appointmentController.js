import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Helper
const cleanPhone = (phone) => phone.replace(/\D/g, '');

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;
  let { sessionId } = req.body;

  if (!appointmentId) {
    return res.status(400).json({ error: 'appointmentId é obrigatório.' });
  }

  try {
    console.log(`[AGENDA] 📅 Processando confirmação ID: ${appointmentId}`);

    // 1. Buscar dados do agendamento
    const { data: app, error } = await supabase
      .from('appointments')
      .select(`
        *,
        leads (name, phone),
        profiles:user_id (name),
        companies (name)
      `)
      .eq('id', appointmentId)
      .single();

    if (error || !app) {
      return res.status(404).json({ error: 'Agendamento não encontrado.' });
    }

    // 2. Resolução de Sessão (Se não veio no body)
    if (!sessionId) {
      const { data: instance } = await supabase
        .from('instances')
        .select('session_id')
        .eq('company_id', app.company_id)
        .eq('status', 'connected')
        .limit(1)
        .maybeSingle();
      
      if (!instance) {
        return res.status(503).json({ error: 'WhatsApp desconectado.' });
      }
      sessionId = instance.session_id;
    }

    // 3. Buscar Regras de Notificação (Engine)
    // Pega a regra ativa do dono da agenda para saber O QUE enviar
    const { data: rules } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('user_id', app.user_id)
        .eq('company_id', app.company_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    // Se não tiver regra configurada, encerra sem erro (é opcional)
    if (!rules?.notification_config) {
        return res.json({ message: "Sem regras de notificação configuradas." });
    }

    const config = rules.notification_config;
    const tasks = [];

    // Preparar Variáveis do Template
    const dateObj = new Date(app.start_time);
    const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
    const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
    
    const replaceVars = (tpl) => {
        return tpl
            .replace('[lead_name]', app.leads?.name || 'Cliente')
            .replace('[lead_phone]', app.leads?.phone || '')
            .replace('[empresa]', app.companies?.name || '')
            .replace('[data]', dateStr)
            .replace('[hora]', timeStr);
    };

    // A. Notificar Admin (Dono da Agenda)
    if (config.admin_phone && config.admin_notifications) {
        const onBookingAdmin = config.admin_notifications.find(n => n.type === 'on_booking' && n.active);
        if (onBookingAdmin) {
            const adminMsg = replaceVars(onBookingAdmin.template);
            const adminPhone = cleanPhone(config.admin_phone);
            tasks.push(sendMessage(sessionId, `${adminPhone}@s.whatsapp.net`, { text: adminMsg }));
        }
    }

    // B. Notificar Lead (Cliente) - Confirmação Imediata
    if (app.leads?.phone && config.lead_notifications) {
        const onBookingLead = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        if (onBookingLead) {
            const leadMsg = replaceVars(onBookingLead.template);
            const leadPhone = cleanPhone(app.leads.phone);
            tasks.push(sendMessage(sessionId, `${leadPhone}@s.whatsapp.net`, { text: leadMsg }));
        }
    }

    // 4. Executar Envios
    await Promise.all(tasks);

    // 5. Atualizar flag
    await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);

    console.log(`[AGENDA] ✅ Confirmações enviadas: ${tasks.length}`);
    return res.status(200).json({ success: true, count: tasks.length });

  } catch (error) {
    console.error('[AGENDA] ❌ Erro crítico:', error);
    return res.status(500).json({ error: error.message });
  }
};
