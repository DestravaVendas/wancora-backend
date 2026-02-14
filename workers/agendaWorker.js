
import cron from 'node-cron';
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { getSessionId } from '../controllers/whatsappController.js';
import getRedisClient from '../services/redisClient.js'; // Import Redis

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const cleanPhone = (phone) => phone.replace(/\D/g, '');

const processReminders = async () => {
    const redis = getRedisClient();
    const LOCK_KEY = 'worker:agenda:lock';
    const LOCK_TTL = 290; 

    try {
        if (redis) {
            const acquired = await redis.set(LOCK_KEY, 'LOCKED', 'EX', LOCK_TTL, 'NX');
            if (!acquired) {
                // Silencioso: Worker anterior ainda rodando
                return;
            }
        }

        // Log removido conforme solicitado: console.log('⏰ [Agenda Worker] Ciclo iniciado...');
        
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        // ============================================================
        // 1. REDE DE SEGURANÇA: Confirmações Imediatas (ON_BOOKING)
        // ============================================================
        // Busca agendamentos criados recentemente (última 1h) que NÃO tiveram confirmação enviada
        // Isso cobre falhas de API ou timeouts no momento do agendamento
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        
        const { data: missedConfirmations } = await supabase
            .from('appointments')
            .select(`
                *,
                leads (id, name, phone),
                companies (name),
                availability_rules (notification_config)
            `)
            .eq('confirmation_sent', false) // Ainda não enviou
            .gte('created_at', oneHourAgo.toISOString()) // Criado recentemente
            .neq('status', 'cancelled');

        if (missedConfirmations && missedConfirmations.length > 0) {
            console.log(`🚨 [Agenda Worker] Recuperando ${missedConfirmations.length} confirmações falhas.`);
            
            for (const app of missedConfirmations) {
                const config = app.availability_rules?.notification_config;
                if (!config || !app.leads?.phone) continue;

                // Tenta encontrar e disparar o trigger 'on_booking'
                const sessionId = await getSessionId(app.company_id);
                if (!sessionId) continue;

                const dateObj = new Date(app.start_time);
                const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
                const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
                const replaceVars = (t) => t.replace('[lead_name]', app.leads.name).replace('[data]', dateStr).replace('[hora]', timeStr).replace('[empresa]', app.companies?.name || '');

                // Envia para o Lead (Prioridade)
                const leadTrigger = config.lead_notifications?.find(n => n.type === 'on_booking' && n.active);
                if (leadTrigger) {
                     const leadPhone = cleanPhone(app.leads.phone);
                     await sendMessage({ sessionId, to: `${leadPhone}@s.whatsapp.net`, type: 'text', content: replaceVars(leadTrigger.template) }).catch(() => {});
                }

                // Envia para Admin
                const adminTrigger = config.admin_notifications?.find(n => n.type === 'on_booking' && n.active);
                if (adminTrigger && config.admin_phone) {
                    const adminPhone = cleanPhone(config.admin_phone);
                    await sendMessage({ sessionId, to: `${adminPhone}@s.whatsapp.net`, type: 'text', content: replaceVars(adminTrigger.template) }).catch(() => {});
                }

                // Marca como enviado para não repetir
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

                    const margin = 10 * 60 * 1000; // 10 min margin

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
                                content: msg
                            });

                            await supabase.from('appointments').update({ reminder_sent: true }).eq('id', app.id);
                            
                            await supabase.from('lead_activities').insert({
                                company_id: app.company_id,
                                lead_id: app.leads.id,
                                type: 'log',
                                content: `⏰ Lembrete Automático enviado (${amount} ${rule.time_unit} antes).`,
                                created_by: app.user_id,
                                created_at: new Date()
                            });
                        } catch (sendError) {
                            console.error(`❌ [Agenda Worker] Erro no envio:`, sendError.message);
                        }
                        break; 
                    }
                }
            }
        }

    } catch (e) {
        console.error("❌ [Agenda Worker] Falha crítica:", e);
    } finally {
        if (redis) {
            await redis.del(LOCK_KEY);
        }
    }
};

export const startAgendaWorker = () => {
    console.log("📅 [AGENDA] Worker de Notificações Iniciado (Check a cada 5 min).");
    cron.schedule('*/5 * * * *', processReminders);
};
