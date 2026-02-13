
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { Logger } from '../utils/logger.js';
import { sessions, startSession as startBaileysSession } from '../services/baileys/connection.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Helper rigoroso para formatar telefone BR e Internacionais
const formatPhoneForWhatsapp = (phone) => {
    if (!phone) return null;
    let clean = phone.replace(/\D/g, '');
    
    // Regra BR: Se tiver 10 ou 11 dígitos e não começar com 55, adiciona
    if ((clean.length === 10 || clean.length === 11) && !clean.startsWith('55')) {
         clean = '55' + clean;
    }
    return clean;
};

// Espera inteligente pelo Socket
const ensureSocketActive = async (companyId, maxRetries = 10) => {
    // 1. Busca qual sessão DEVERIA estar online segundo o banco
    const { data: instance } = await supabase
        .from('instances')
        .select('session_id, status')
        .eq('company_id', companyId)
        .eq('status', 'connected')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!instance) {
        // Fallback: Tenta pegar qualquer uma se não tiver nenhuma marcada como connected
        const { data: anyInstance } = await supabase
            .from('instances')
            .select('session_id')
            .eq('company_id', companyId)
            .limit(1)
            .maybeSingle();
            
        if (!anyInstance) return null;
        return { sessionId: anyInstance.session_id, sock: null }; // Retorna ID para tentativa, mas sem garantia
    }

    const sessionId = instance.session_id;

    // 2. Verifica se está na memória RAM
    let session = sessions.get(sessionId);

    // 3. Se não estiver na RAM, mas o banco diz que deveria estar -> Ressuscita (Warm-up)
    if (!session) {
        console.log(`[AGENDA] Sessão ${sessionId} consta como online no DB mas não na RAM. Restaurando...`);
        try {
            await startBaileysSession(sessionId, companyId);
        } catch (e) {
            console.error("[AGENDA] Erro ao restaurar sessão:", e);
        }
    }

    // 4. Polling rápido para aguardar o socket ficar pronto (até 5 segundos)
    for (let i = 0; i < maxRetries; i++) {
        session = sessions.get(sessionId);
        if (session?.sock?.ws?.isOpen) {
            return { sessionId, sock: session.sock };
        }
        await new Promise(r => setTimeout(r, 500));
    }

    return { sessionId, sock: null }; // Retorna o ID mesmo se falhar o socket, para logar erro
};

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;
  
  // LOG INICIAL
  Logger.info('backend', `[AGENDA] 🚀 Disparando aviso para Appt: ${appointmentId}`, { appointmentId }, companyId);

  try {
    if (!appointmentId) throw new Error('appointmentId ausente.');

    // 1. Busca Dados Completos
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
      Logger.error('backend', `[AGENDA] Agendamento não encontrado no banco.`, { error: error?.message }, companyId);
      return res.status(404).json({ error: 'Agendamento não existe.' });
    }

    // Trava de segurança para não enviar duplicado
    if (app.confirmation_sent) {
        return res.json({ message: "Aviso já enviado anteriormente." });
    }

    // 2. Obtém/Restaura Sessão Ativa
    const sessionData = await ensureSocketActive(app.company_id);
    
    if (!sessionData || !sessionData.sessionId) {
        Logger.error('backend', `[AGENDA] Nenhuma instância de WhatsApp configurada.`, {}, app.company_id);
        return res.status(503).json({ error: 'Sem WhatsApp conectado.' });
    }

    const { sessionId, sock } = sessionData;

    if (!sock) {
        Logger.warn('backend', `[AGENDA] Sessão ${sessionId} existe mas Socket está offline. Agendado para Worker.`, {}, app.company_id);
        // Retorna 200 para não quebrar o frontend, o Worker pegará depois pois confirmation_sent continua false
        return res.json({ warning: "Socket offline. Worker tentará em breve." });
    }

    // 3. Carrega Regras de Notificação
    const { data: rules } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('company_id', app.company_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    if (!rules?.notification_config) {
        return res.json({ message: "Sem configuração de notificação." });
    }

    const config = rules.notification_config;
    const tasks = [];

    // Formatadores de Data/Hora
    const dateObj = new Date(app.start_time);
    const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
    const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
    
    const replaceVars = (tpl) => tpl
            .replace(/\[lead_name\]/g, app.leads?.name || 'Cliente')
            .replace(/\[lead_phone\]/g, app.leads?.phone || '')
            .replace(/\[empresa\]/g, app.companies?.name || 'Nossa Empresa')
            .replace(/\[data\]/g, dateStr)
            .replace(/\[hora\]/g, timeStr);

    // 4. Preparação dos Envios (Admin & Lead)

    // -> ADMIN
    if (config.admin_phone && config.admin_notifications) {
        const trigger = config.admin_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const msg = replaceVars(trigger.template);
            const phone = formatPhoneForWhatsapp(config.admin_phone);
            if (phone) {
                tasks.push(
                    sendMessage({ 
                        sessionId, 
                        companyId: app.company_id, 
                        to: `${phone}@s.whatsapp.net`, 
                        type: 'text', 
                        content: msg 
                    }).then(() => Logger.info('backend', `[AGENDA] Enviado para Admin (${phone})`, {}, app.company_id))
                );
            }
        }
    }

    // -> LEAD
    if (app.leads?.phone && config.lead_notifications) {
        const trigger = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const msg = replaceVars(trigger.template);
            const phone = formatPhoneForWhatsapp(app.leads.phone);
            if (phone) {
                tasks.push(
                    sendMessage({ 
                        sessionId, 
                        companyId: app.company_id, 
                        to: `${phone}@s.whatsapp.net`, 
                        type: 'text', 
                        content: msg 
                    }).then(() => Logger.info('backend', `[AGENDA] Enviado para Lead (${phone})`, {}, app.company_id))
                );
            }
        }
    }

    // 5. Execução e Atualização de Status
    if (tasks.length > 0) {
        await Promise.all(tasks);
        
        // Marca como enviado SÓ se passar pelo envio sem erro crítico
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        
        Logger.info('backend', `[AGENDA] ✅ Ciclo completo. ${tasks.length} mensagens enviadas.`, {}, app.company_id);
        return res.status(200).json({ success: true, count: tasks.length });
    } else {
        Logger.info('backend', `[AGENDA] Nenhuma mensagem configurada para enviar (Check triggers).`, {}, app.company_id);
        return res.json({ message: "Nenhum trigger ativo configurado." });
    }

  } catch (error) {
    Logger.error('backend', `[AGENDA] ❌ Erro Crítico no Controller`, { error: error.message, stack: error.stack }, companyId);
    return res.status(500).json({ error: error.message });
  }
};
