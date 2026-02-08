
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
  
  // Objeto de Debug para retornar ao frontend
  const debug = {
      step: 'init',
      appointmentId,
      companyId,
      logs: []
  };

  const addLog = (msg) => {
      console.log(`[AGENDA DEBUG] ${msg}`);
      debug.logs.push(msg);
  };

  if (!appointmentId) {
    return res.status(400).json({ error: 'appointmentId é obrigatório.', debug });
  }

  try {
    addLog(`Iniciando processamento para ID: ${appointmentId}`);

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
      addLog(`❌ Agendamento não encontrado no banco.`);
      return res.status(404).json({ error: 'Agendamento não encontrado.', debug });
    }
    
    addLog(`✅ Agendamento encontrado. Lead: ${app.leads?.name} (${app.leads?.phone})`);

    // Validação de Duplicidade
    if (app.confirmation_sent) {
        addLog(`⚠️ Confirmação já marcada como enviada.`);
        // Removemos o return para forçar o teste se necessário, ou descomente abaixo
        // return res.json({ message: "Já enviado.", debug });
    }

    // 2. Resolução Inteligente de Sessão
    if (!sessionId) {
      addLog(`🔍 Buscando sessão WhatsApp conectada...`);
      const { data: instances } = await supabase
        .from('instances')
        .select('session_id, status')
        .eq('company_id', app.company_id)
        .eq('status', 'connected'); 
      
      if (instances && instances.length > 0) {
        sessionId = instances[0].session_id;
        addLog(`✅ Sessão conectada encontrada: ${sessionId}`);
      } else {
         addLog(`⚠️ Nenhuma sessão 'connected' encontrada. Tentando qualquer uma...`);
         const { data: anyInstance } = await supabase
            .from('instances')
            .select('session_id, status')
            .eq('company_id', app.company_id)
            .limit(1)
            .maybeSingle();
            
        if (anyInstance) {
            sessionId = anyInstance.session_id;
            addLog(`⚠️ Usando sessão fallback (Status: ${anyInstance.status}): ${sessionId}`);
        } else {
            addLog(`❌ NENHUMA INSTÂNCIA CADASTRADA PARA EMPRESA ${app.company_id}`);
        }
      }
    }

    if (!sessionId) {
        return res.status(503).json({ error: 'Nenhuma conexão WhatsApp disponível.', debug });
    }

    // 3. Buscar Regras de Notificação
    addLog(`🔍 Buscando regras de disponibilidade (user_id: ${app.user_id})...`);
    
    // Tenta buscar regra específica deste user ou global
    const { data: rules } = await supabase
        .from('availability_rules')
        .select('notification_config, slug')
        .eq('company_id', app.company_id)
        .eq('is_active', true)
        // Se o appointment foi criado, deve haver uma regra. Vamos tentar pegar a regra genérica se não achar a exata
        .limit(1)
        .maybeSingle();

    if (!rules?.notification_config) {
        addLog(`❌ Nenhuma regra de notificação configurada na tabela availability_rules.`);
        return res.json({ message: "Sem regras configuradas.", debug });
    }

    const config = rules.notification_config;
    addLog(`✅ Regras encontradas (Slug: ${rules.slug}). Admin Phone: ${config.admin_phone}`);

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
            
            addLog(`📤 Preparando envio ADMIN para ${adminJid}: "${adminMsg.substring(0, 30)}..."`);
            
            tasks.push(sendMessage({ 
                sessionId, 
                companyId: app.company_id,
                to: adminJid, 
                type: 'text', 
                content: adminMsg 
            }).then(() => addLog(`✅ Admin enviado.`)).catch(e => addLog(`❌ Falha Admin: ${e.message}`)));
        } else {
            addLog(`ℹ️ Nenhuma notificação 'on_booking' ativa para Admin.`);
        }
    } else {
        addLog(`ℹ️ Admin phone não configurado.`);
    }

    // B. Notificar Lead
    if (app.leads?.phone && config.lead_notifications) {
        const onBookingLead = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        
        if (onBookingLead) {
            const leadMsg = replaceVars(onBookingLead.template);
            const leadPhone = formatPhoneForWhatsapp(app.leads.phone);
            const leadJid = `${leadPhone}@s.whatsapp.net`;
            
            addLog(`📤 Preparando envio LEAD para ${leadJid}: "${leadMsg.substring(0, 30)}..."`);
            
            tasks.push(sendMessage({ 
                sessionId, 
                companyId: app.company_id,
                to: leadJid, 
                type: 'text', 
                content: leadMsg 
            }).then(() => addLog(`✅ Lead enviado.`)).catch(e => addLog(`❌ Falha Lead: ${e.message}`)));
        } else {
            addLog(`ℹ️ Nenhuma notificação 'on_booking' ativa para Lead.`);
        }
    } else {
        addLog(`ℹ️ Lead sem telefone ou sem notificações configuradas.`);
    }

    // 4. Executar Envios
    if (tasks.length > 0) {
        await Promise.all(tasks);
        
        // 5. Marcar confirmação como enviada
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        
        addLog(`🏁 Processo finalizado.`);
    } else {
        addLog(`⚠️ Nenhuma tarefa de envio foi gerada.`);
    }

    return res.status(200).json({ success: true, debug });

  } catch (error) {
    addLog(`❌ ERRO FATAL NO CONTROLLER: ${error.message}`);
    return res.status(500).json({ error: error.message, debug });
  }
};
