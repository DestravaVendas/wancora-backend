
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
    await sleep(3000); // Aumentado para 3s para garantir propagação do DB

    // 2. BUSCA CONFIGURAÇÃO
    const { data: rule } = await supabase
        .from('availability_rules')
        .select('notification_config')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    const config = rule?.notification_config;
    
    if (!config) {
        console.warn(`[${TRACE_ID}] ⚠️ Nenhuma regra de notificação ativa encontrada.`);
        return res.json({ status: 'no_config' });
    }

    // 3. SELEÇÃO DE SESSÃO COM AUTO-HEAL
    let activeSessionId = null;
    let session = null;

    // A. Tenta sessão específica configurada
    if (config.sending_session_id) {
        session = sessions.get(config.sending_session_id);
        if (session?.sock) {
            activeSessionId = config.sending_session_id;
            console.log(`[${TRACE_ID}] ✅ Usando sessão configurada: ${activeSessionId}`);
        } else {
             console.warn(`[${TRACE_ID}] ⚠️ Sessão configurada ${config.sending_session_id} offline na RAM.`);
        }
    }

    // B. Fallback Inteligente (Busca qualquer conectada)
    if (!activeSessionId) {
        // Busca o que o banco DIZ que está conectado
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

            // C. AUTO-HEAL DE EMERGÊNCIA
            // Se o banco diz que tem sessões conectadas, mas a RAM está vazia, o servidor pode ter reiniciado sem restaurar.
            // Vamos tentar acordar a primeira sessão encontrada.
            if (!activeSessionId) {
                const emergencyId = dbInstances[0].session_id;
                console.warn(`[${TRACE_ID}] 🚨 EMERGÊNCIA: Banco diz que ${emergencyId} está online, mas RAM não. Tentando reviver...`);
                try {
                    // Tenta iniciar sessão (sem await longo para não travar request, mas torcendo pra dar tempo)
                    // Nota: startSession é async, mas sock.ev.on('open') demora. 
                    // O ideal aqui é apenas logar o erro e disparar o start para a PRÓXIMA vez funcionar.
                    startSession(emergencyId, companyId).catch(err => console.error("Erro Auto-Heal:", err));
                    
                    // Retorna erro 'retry' para quem sabe um worker tentar depois?
                    // Por enquanto, falha graceful.
                    return res.json({ status: 'session_reviving', message: 'Sessão estava adormecida. Acordando...' });
                } catch (e) {
                    console.error(`[${TRACE_ID}] Falha no Auto-Heal:`, e);
                }
            }
        }
    }

    if (!activeSessionId) {
        await Logger.error('backend', `[AGENDA] Nenhuma sessão disponível (RAM vazia).`, { appointmentId, availableInRam: [...sessions.keys()] }, companyId);
        return res.json({ status: 'sessions_offline_everywhere' });
    }

    // 4. Busca Dados do Agendamento
    const { data: app } = await supabase
      .from('appointments')
      .select(`*, leads (name, phone), companies (name)`)
      .eq('id', appointmentId)
      .single();

    if (!app) return res.json({ status: 'appointment_not_found' });
    if (app.confirmation_sent) {
        console.log(`[${TRACE_ID}] ℹ️ Já enviado anteriormente.`);
        return res.json({ status: 'already_sent' });
    }

    // 5. Envio das Mensagens
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
                console.log(`[${TRACE_ID}] 📤 Enviando para Admin (${phone})...`);
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

    // -> LEAD
    if (app.leads?.phone && config.lead_notifications) {
        const trigger = config.lead_notifications.find(n => n.type === 'on_booking' && n.active);
        if (trigger) {
            const phone = cleanPhone(app.leads.phone);
            if (phone) {
                console.log(`[${TRACE_ID}] 📤 Enviando para Lead (${phone})...`);
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

    // 6. Conclusão
    if (tasks.length > 0) {
        await Promise.all(tasks);
        await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', appointmentId);
        
        console.log(`[${TRACE_ID}] ✨ Sucesso! ${tasks.length} mensagens enviadas.`);
        await Logger.info('backend', `[AGENDA] Notificações enviadas com sucesso.`, { appointmentId, count: tasks.length }, companyId);
        
        return res.json({ success: true, sent: tasks.length });
    }

    console.log(`[${TRACE_ID}] ⚠️ Nenhuma ação configurada ou telefones inválidos.`);
    return res.json({ status: 'no_actions_needed' });

  } catch (error) {
    console.error(`[${appointmentId}] ❌ FATAL CRASH:`, error);
    Logger.error('backend', `[AGENDA] Erro Crítico Controller`, { error: error.message, stack: error.stack }, companyId);
    return res.status(200).json({ error: error.message });
  }
};
