
import cron from 'node-cron';
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { getSessionId } from '../controllers/whatsappController.js';
import { sessions } from '../services/baileys/connection.js'; // Import Necessário para checar status
import getRedisClient from '../services/redisClient.js'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const cleanPhone = (phone) => {
    if(!phone) return null;
    return phone.replace(/\D/g, '');
};

// Helper para resolver qual sessão usar (Preferência > Fallback)
const resolveSession = async (companyId, preferredSessionId) => {
    // 1. Tenta a preferida
    if (preferredSessionId) {
        const session = sessions.get(preferredSessionId);
        if (session?.sock) return preferredSessionId;
    }
    // 2. Fallback: Pega qualquer uma conectada
    return await getSessionId(companyId);
};

const processReminders = async () => {
    const redis = getRedisClient();
    const LOCK_KEY = 'worker:agenda:lock';
    const LOCK_TTL = 55; 

    try {
        if (redis) {
            const acquired = await redis.set(LOCK_KEY, 'LOCKED', 'EX', LOCK_TTL, 'NX');
            if (!acquired) return;
        }

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

                if (!config) continue;

                // Resolve a sessão respeitando a preferência
                const sessionId = await resolveSession(app.company_id, config.sending_session_id);
                
                if (!sessionId) continue;

                const dateObj = new Date(app.start_time);
                const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
                const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
                
                const replaceVars = (t, name) => t
                    .replace(/\[nome_do_lead\]/g, name || 'Cliente')
                    .replace(/\[lead_name\]/g, name || 'Cliente')
                    .replace(/\[data\]/g, dateStr)
                    .replace(/\[hora\]/g, timeStr)
                    .replace(/\[empresa\]/g, app.companies?.name || '');

                const recipients = [];
                if (app.leads?.phone) recipients.push({ name: app.leads.name, phone: app.leads.phone });
                if (app.guests && Array.isArray(app.guests)) {
                    app.guests.forEach(g => {
                        if (!recipients.find(r => r.phone === g.phone)) recipients.push(g);
                    });
                }

                const leadTrigger = config.lead_notifications?.find(n => n.type === 'on_booking' && n.active);
                if (leadTrigger && recipients.length > 0) {
                     for (const r of recipients) {
                         const phone = cleanPhone(r.phone);
                         if(phone) {
                             await sendMessage({ 
                                 sessionId, 
                                 to: `${phone}@s.whatsapp.net`, 
                                 type: 'text', 
                                 content: replaceVars(leadTrigger.template, r.name), 
                                 companyId: app.company_id 
                             }).catch(() => {});
                         }
                     }
                }

                const adminTrigger = config.admin_notifications?.find(n => n.type === 'on_booking' && n.active);
                if (adminTrigger && config.admin_phone) {
                    const adminPhone = cleanPhone(config.admin_phone);
                    await sendMessage({ 
                        sessionId, 
                        to: `${adminPhone}@s.whatsapp.net`, 
                        type: 'text', 
                        content: replaceVars(adminTrigger.template, recipients[0]?.name), 
                        companyId: app.company_id 
                    }).catch(() => {});
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
                
                const recipients = [];
                if (app.leads?.phone) recipients.push({ name: app.leads.name, phone: app.leads.phone });
                if (app.guests && Array.isArray(app.guests)) {
                    app.guests.forEach(g => {
                        if (!recipients.find(r => r.phone === g.phone)) recipients.push(g);
                    });
                }

                if (!config || !config.lead_notifications || recipients.length === 0) continue;

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

                    const margin = 2 * 60 * 1000; 

                    if (timeUntil <= ruleTimeMs && timeUntil > (ruleTimeMs - margin)) {
                        
                        // Resolve a sessão respeitando a preferência
                        const sessionId = await resolveSession(app.company_id, config.sending_session_id);
                        if (!sessionId) continue;

                        const dateObj = new Date(app.start_time);
                        const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
                        const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);

                        for (const recipient of recipients) {
                            const leadPhone = cleanPhone(recipient.phone);
                            if (!leadPhone) continue;

                            let msg = rule.template
                                .replace(/\[nome_do_lead\]/g, recipient.name || 'Cliente')
                                .replace(/\[lead_name\]/g, recipient.name || 'Cliente')
                                .replace(/\[empresa\]/g, app.companies?.name || '')
                                .replace(/\[data\]/g, dateStr)
                                .replace(/\[hora\]/g, timeStr)
                                .replace(/\[local\]/g, app.category || 'Online');
                            
                            try {
                                await sendMessage({
                                    sessionId,
                                    to: `${leadPhone}@s.whatsapp.net`,
                                    type: 'text',
                                    content: msg,
                                    companyId: app.company_id
                                });
                            } catch (sendError) {
                                console.error(`❌ [Agenda] Falha envio ${leadPhone}:`, sendError.message);
                            }
                        }

                        await supabase.from('appointments').update({ reminder_sent: true }).eq('id', app.id);
                        
                        if (app.leads?.id) {
                            await supabase.from('lead_activities').insert({
                                company_id: app.company_id,
                                lead_id: app.leads.id,
                                type: 'log',
                                content: `⏰ Lembrete Automático enviado para ${recipients.length} participantes (${amount} ${rule.time_unit} antes).`,
                                created_by: app.user_id,
                                created_at: new Date()
                            });
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
    console.log("📅 [AGENDA] Worker Silencioso Iniciado (Check a cada 1 min).");
    cron.schedule('* * * * *', processReminders);
};
