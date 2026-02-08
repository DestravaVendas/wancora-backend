
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { normalizeJid } from '../utils/wppParsers.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Helper de Limpeza e Formatação BR
const formatPhoneForWhatsapp = (phone) => {
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
        companies (name)
      `)
      .eq('id', appointmentId)
      .single();

    if (error || !app) {
      console.error(`[AGENDA] Agendamento não encontrado: ${appointmentId}`);
      return res.status(404).json({ error: 'Agendamento não encontrado.' });
    }

    // Validação de Duplicidade (Evita spam se o frontend tentar retry)
    if (app.confirmation_sent) {
        console.log(`[AGENDA] Confirmação já enviada anteriormente para ${appointmentId}. Ignorando.`);
        return res.json({ message: "Já enviado." });
    }

    // 2. Resolução Inteligente de Sessão
    // Busca uma sessão CONECTADA da empresa.
    if (!sessionId) {
      const { data: instances } = await supabase
        .from('instances')
        .select('session_id')
        .eq('company_id', app.company_id)
        .eq('status', 'connected'); // Prioridade para conectados
      
      if (instances && instances.length > 0) {
        // Pega a primeira conectada
        sessionId = instances[0].session_id;
      } else {
        // Fallback: Tenta qualquer uma (talvez esteja conectando)
        const { data: anyInstance } = await supabase
            .from('instances')
            .select('session_id')
            .eq('company_id', app.company_id)
            .limit(1)
            .maybeSingle();
            
        if (anyInstance) sessionId = anyInstance.session_id;
      }

      if (!sessionId) {
        console.warn(`[AGENDA] Nenhuma instância disponível para empresa ${app.company_id}`);
        return res.status(503).json({ error: 'Nenhuma conexão WhatsApp disponível.' });
      }
    }

    // 3. Buscar Regras de Notificação
    const { data: rules } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('user_id', app.user_id)
        .eq('company_id', app.company_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    if (!rules?.notification_config) {
        console.log(`[AGENDA] Sem regras de notificação configuradas.`);
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
            .replace('[lead_name]', app.leads?.name || 'Cliente')
            .replace('[lead_phone]', app.leads?.phone || '')
            .replace('[empresa]', app.companies?.name || 'Nossa Empresa')
            .replace('[data]', dateStr)
            .replace('[hora]', timeStr);
    };

    // A. Notificar Admin (Dono da Agenda)
    if (config.admin_phone && config.admin_notifications) {
        const onBookingAdmin = config.admin_notifications.find(n => n.type === 'on_booking' && n.active);
        
        if (onBookingAdmin) {
            const adminMsg = replaceVars(onBookingAdmin.template);
            const adminPhone = formatPhoneForWhatsapp(config.admin_phone);
            
            console.log(`[AGENDA] Enviando aviso ADMIN para ${adminPhone}`);
            tasks.push(sendMessage({ 
                sessionId, 
                companyId: app.company_id,
                to: `${adminPhone}@s.whatsapp.net`, 
                type: 'text', 
                content: adminMsg 
            }).catch(e => console.error(`[AGENDA] Falha envio Admin:`, e.message)));
        }
    }

    // B. Notificar Lead (Cliente)
    if (app.leads?.phone && config.lead_notifications) {
        const onBookingLead = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        
        if (onBookingLead) {
            const leadMsg = replaceVars(onBookingLead.template);
            const leadPhone = formatPhoneForWhatsapp(app.leads.phone);
            
            console.log(`[AGENDA] Enviando aviso LEAD para ${leadPhone}`);
            tasks.push(sendMessage({ 
                sessionId, 
                companyId: app.company_id,
                to: `${leadPhone}@s.whatsapp.net`, 
                type: 'text', 
                content: leadMsg 
            }).catch(e => console.error(`[AGENDA] Falha envio Lead:`, e.message)));
        }
    }

    // 4. Executar Envios
    if (tasks.length > 0) {
        await Promise.all(tasks);
        
        // 5. Marcar confirmação como enviada e logar atividade
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        
        // Log no histórico do lead
        if (app.leads?.id) {
            await supabase.from('lead_activities').insert({
                company_id: app.company_id,
                lead_id: app.leads.id,
                type: 'log',
                content: `📅 Confirmação de agendamento enviada automaticamente via WhatsApp.`,
                created_by: app.user_id,
                created_at: new Date()
            });
        }

        console.log(`[AGENDA] ✅ Notificações processadas com sucesso.`);
    } else {
        console.log(`[AGENDA] Nenhuma notificação 'on_booking' ativa encontrada.`);
    }

    return res.status(200).json({ success: true, sent_count: tasks.length });

  } catch (error) {
    console.error('[AGENDA] ❌ Erro fatal no envio:', error);
    return res.status(500).json({ error: error.message });
  }
};
