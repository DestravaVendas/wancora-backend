
import cron from 'node-cron';
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { getSessionId } from '../controllers/whatsappController.js';
import getRedisClient from '../services/redisClient.js'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const cleanPhone = (phone) => phone.replace(/\D/g, '');

const processReminders = async () => {
    const redis = getRedisClient();
    const LOCK_KEY = 'worker:agenda:lock';
    // TTL Ajustado: 55s (Para rodar a cada minuto sem colisão)
    const LOCK_TTL = 55; 

    try {
        if (redis) {
            const acquired = await redis.set(LOCK_KEY, 'LOCKED', 'EX', LOCK_TTL, 'NX');
            if (!acquired) {
                // Silencioso: Worker anterior ainda processando ou lock ativo
                return;
            }
        }

        // --- MODO SILENCIOSO: SEM LOGS DE INÍCIO ---
        
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        // ============================================================
        // 1. REDE DE SEGURANÇA: Confirmações Imediatas (ON_BOOKING)
        // ============================================================
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        
        const { data: missedConfirmations } = await supabase
            .from('appointments')
            .select(`
                *,
                leads (id, name, phone),
                companies (name),
                availability_rules (notification_config)
            `)
            .eq('confirmation_sent', false)
            .gte('created_at', oneHourAgo.toISOString())
            .neq('status', 'cancelled');

        if (missedConfirmations && missedConfirmations.length > 0) {
            // Log apenas se encontrar trabalho a fazer
            // console.log(`🚨 [Agenda] Processando ${missedConfirmations.length} confirmações pendentes.`);
            
            for (const app of missedConfirmations) {
                let config = app.availability_rules?.notification_config;
                
                if (!config) {
                     const { data: rules } = await supabase.from('availability_rules')
                        .select('notification_config')
                        .eq('company_id', app.company_id)
                        .eq('is_active', true)
                        .limit(1);
                     config = rules?.[0]?.notification_config;
                }

                if (!config || !app.leads?.phone) continue;

                let sessionId = config.sending_session_id 
                    ? await getSessionId(app.company_id) 
                    : await getSessionId(app.company_id);

                if (!sessionId && config.sending_session_id) sessionId = config.sending_session_id; 
                
                if (!sessionId) continue;

                const dateObj = new Date(app.start_time);
                const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
                const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
                const replaceVars = (t) => t.replace('[lead_name]', app.leads.name).replace('[data]', dateStr).replace('[hora]', timeStr).replace('[empresa]', app.companies?.name || '');

                const leadTrigger = config.lead_notifications?.find(n => n.type === 'on_booking' && n.active);
                if (leadTrigger) {
                     const leadPhone = cleanPhone(app.leads.phone);
                     await sendMessage({ sessionId, to: `${leadPhone}@s.whatsapp.net`, type: 'text', content: replaceVars(leadTrigger.template), companyId: app.company_id }).catch(() => {});
                }

                const adminTrigger = config.admin_notifications?.find(n => n.type === 'on_booking' && n.active);
                if (adminTrigger && config.admin_phone) {
                    const adminPhone = cleanPhone(config.admin_phone);
                    await sendMessage({ sessionId, to: `${adminPhone}@s.whatsapp.net`, type: 'text', content: replaceVars(adminTrigger.template), companyId: app.company_id }).catch(() => {});
                }

                await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', app.id);
            }
        }

        // ============================================================
        // 2. LEMBRETES PADRÃO (BEFORE_EVENT)
        // ============================================================
        const { data: appointments } = await supabase
            .from('appointments')
            .select(`
                *,
                leads (id, name, phone),
                companies (name),
                availability_rules (notification_config)
            `)
            .eq('status', 'confirmed')
            .eq('reminder_sent', false)
            .gte('start_time', now.toISOString())
            .lte('start_time', tomorrow.toISOString());

        if (appointments && appointments.length > 0) {
            for (const app of appointments) {
                const config = app.availability_rules?.notification_config;
                if (!config || !config.lead_notifications || !app.leads?.phone) continue;

                const leadReminders = config.lead_notifications.filter(n => n.type === 'before_event' && n.active);
                if (leadReminders.length === 0) continue;

                const appTime = new Date(app.start_time).getTime();
                const timeUntil = appTime - now.getTime();
                
                for (const rule of leadReminders) {
                    let ruleTimeMs = 0;
                    const amount = Number(rule.time_amount);
                    if (rule.time_unit === 'minutes') ruleTimeMs = amount * 60 * 1000;
                    else if (rule.time_unit === 'hours') ruleTimeMs = amount * 60 * 60 * 1000;
                    else if (rule.time_unit === 'days') ruleTimeMs = amount * 24 * 60 * 60 * 1000;

                    // Tolerância reduzida para 2 minutos (já que o worker roda a cada 1 min)
                    const margin = 2 * 60 * 1000; 

                    // Verifica se está na janela de tempo exata
                    if (timeUntil <= ruleTimeMs && timeUntil > (ruleTimeMs - margin)) {
                        const sessionId = await getSessionId(app.company_id);
                        if (!sessionId) continue;

                        const dateObj = new Date(app.start_time);
                        const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
                        const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);

                        let msg = rule.template
                            .replace('[lead_name]', app.leads.name || 'Cliente')
                            .replace('[empresa]', app.companies?.name || '')
                            .replace('[data]', dateStr)
                            .replace('[hora]', timeStr);

                        const leadPhone = cleanPhone(app.leads.phone);
                        
                        try {
                            await sendMessage({
                                sessionId,
                                to: `${leadPhone}@s.whatsapp.net`,
                                type: 'text',
                                content: msg,
                                companyId: app.company_id
                            });

                            await supabase.from('appointments').update({ reminder_sent: true }).eq('id', app.id);
                            
                            // Log de atividade é útil, mantido.
                            await supabase.from('lead_activities').insert({
                                company_id: app.company_id,
                                lead_id: app.leads.id,
                                type: 'log',
                                content: `⏰ Lembrete Automático enviado (${amount} ${rule.time_unit} antes).`,
                                created_by: app.user_id,
                                created_at: new Date()
                            });
                        } catch (sendError) {
                            // Erro real de envio deve aparecer
                            console.error(`❌ [Agenda] Falha envio ${leadPhone}:`, sendError.message);
                        }
                        break; 
                    }
                }
            }
        }

    } catch (e) {
        // Erro crítico do worker deve aparecer
        console.error("❌ [Agenda Worker] Falha crítica:", e);
    } finally {
        if (redis) {
            await redis.del(LOCK_KEY);
        }
    }
};

export const startAgendaWorker = () => {
    // Cron ajustado para rodar a CADA MINUTO (* * * * *)
    console.log("📅 [AGENDA] Worker Silencioso Iniciado (Check a cada 1 min).");
    cron.schedule('* * * * *', processReminders);
};
