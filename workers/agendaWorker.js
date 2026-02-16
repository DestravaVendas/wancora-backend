
import cron from 'node-cron';
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { getSessionId } from '../controllers/whatsappController.js';
import { sessions } from '../services/baileys/connection.js'; 
import getRedisClient from '../services/redisClient.js'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const cleanPhone = (phone) => {
    if(!phone) return null;
    let p = phone.replace(/\D/g, '');
    if (p.length >= 10 && p.length <= 11 && !p.startsWith('55')) {
        p = '55' + p;
    }
    return p;
};

// Helper para resolver qual sessão usar (Preferência > Fallback)
const resolveSession = async (companyId, preferredSessionId) => {
    // 1. Tenta a preferida se estiver online na RAM
    if (preferredSessionId) {
        const session = sessions.get(preferredSessionId);
        if (session?.sock) return preferredSessionId;
    }
    // 2. Fallback: Pega qualquer uma conectada no banco
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
        // 1. CONFIRMAÇÕES DE AGENDAMENTO (ON_BOOKING)
        // Lógica Principal: Busca TUDO que ainda não foi enviado nas últimas 24h
        // ============================================================
        
        // Olha para trás até 24h (para não pegar lixo muito antigo se o server ficou off dias)
        const lookbackWindow = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        const { data: newBookings } = await supabase
            .from('appointments')
            .select(`
                *,
                leads (id, name, phone),
                companies (name),
                availability_rules (notification_config)
            `)
            .eq('confirmation_sent', false) // OBRIGATÓRIO: Ainda não enviou
            .gte('created_at', lookbackWindow.toISOString()) // Criado recentemente
            .neq('status', 'cancelled');

        if (newBookings && newBookings.length > 0) {
            console.log(`📅 [Agenda Worker] Processando ${newBookings.length} novas confirmações.`);
            
            for (const app of newBookings) {
                // 1. Configuração de Notificação
                let config = app.availability_rules?.notification_config;
                if (!config) {
                     const { data: rules } = await supabase.from('availability_rules')
                        .select('notification_config')
                        .eq('company_id', app.company_id)
                        .eq('is_active', true)
                        .limit(1);
                     config = rules?.[0]?.notification_config;
                }

                // Se não tem config ou notificações desativadas no evento, marca como enviado para não processar de novo
                if (!config || app.send_notifications === false) {
                    await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', app.id);
                    continue;
                }

                // 2. Sessão
                const sessionId = await resolveSession(app.company_id, config.sending_session_id);
                if (!sessionId) {
                    // Se não tem sessão, não marca como enviado, tenta no próximo minuto
                    continue;
                }

                // 3. Preparar Variáveis
                const dateObj = new Date(app.start_time);
                const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
                const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
                
                const replaceVars = (t, name, phone) => t
                    .replace(/\[nome_do_lead\]/g, name || 'Cliente')
                    .replace(/\[lead_name\]/g, name || 'Cliente')
                    .replace(/\[lead_phone\]/g, phone || '')
                    .replace(/\[data\]/g, dateStr)
                    .replace(/\[hora\]/g, timeStr)
                    .replace(/\[local\]/g, app.category || 'Online')
                    .replace(/\[link_reuniao\]/g, app.meet_link || '')
                    .replace(/\[empresa\]/g, app.companies?.name || '');

                // 4. Lista de Destinatários (Broadcast)
                const recipients = [];
                // Lead Principal
                if (app.leads?.phone) recipients.push({ name: app.leads.name, phone: app.leads.phone });
                // Convidados Manuais ou Extras
                if (app.guests && Array.isArray(app.guests)) {
                    app.guests.forEach(g => {
                        const p = cleanPhone(g.phone);
                        if (p && !recipients.find(r => cleanPhone(r.phone) === p)) {
                            recipients.push({ name: g.name, phone: g.phone });
                        }
                    });
                }

                // 5. Disparos
                // A. Para Clientes/Convidados
                const leadTrigger = config.lead_notifications?.find(n => n.type === 'on_booking' && n.active);
                if (leadTrigger && recipients.length > 0) {
                     for (const r of recipients) {
                         const phone = cleanPhone(r.phone);
                         if(phone) {
                             await sendMessage({ 
                                 sessionId, 
                                 to: `${phone}@s.whatsapp.net`, 
                                 type: 'text', 
                                 content: replaceVars(leadTrigger.template, r.name, r.phone), 
                                 companyId: app.company_id 
                             }).catch(e => console.error("Falha envio lead:", e.message));
                         }
                     }
                }

                // B. Para Admin
                const adminTrigger = config.admin_notifications?.find(n => n.type === 'on_booking' && n.active);
                if (adminTrigger && config.admin_phone) {
                    const adminPhone = cleanPhone(config.admin_phone);
                    await sendMessage({ 
                        sessionId, 
                        to: `${adminPhone}@s.whatsapp.net`, 
                        type: 'text', 
                        content: replaceVars(adminTrigger.template, recipients[0]?.name, recipients[0]?.phone), 
                        companyId: app.company_id 
                    }).catch(e => console.error("Falha envio admin:", e.message));
                }

                // 6. Conclusão: Marca como enviado para sair da fila
                await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', app.id);
            }
        }

        // ============================================================
        // 2. LEMBRETES PADRÃO (BEFORE_EVENT)
        // Mantido igual: Verifica 24h futuras para avisos programados
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
                         const p = cleanPhone(g.phone);
                         if (p && !recipients.find(r => cleanPhone(r.phone) === p)) {
                             recipients.push({ name: g.name, phone: g.phone });
                         }
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

                    // Margem de erro de 2 minutos
                    const margin = 2 * 60 * 1000; 

                    if (timeUntil <= ruleTimeMs && timeUntil > (ruleTimeMs - margin)) {
                        
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
                                .replace(/\[lead_phone\]/g, recipient.phone || '')
                                .replace(/\[empresa\]/g, app.companies?.name || '')
                                .replace(/\[data\]/g, dateStr)
                                .replace(/\[hora\]/g, timeStr)
                                .replace(/\[link_reuniao\]/g, app.meet_link || '')
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
                                console.error(`❌ [Agenda] Falha envio lembrete ${leadPhone}:`, sendError.message);
                            }
                        }

                        await supabase.from('appointments').update({ reminder_sent: true }).eq('id', app.id);
                        
                        if (app.leads?.id) {
                            await supabase.from('lead_activities').insert({
                                company_id: app.company_id,
                                lead_id: app.leads.id,
                                type: 'log',
                                content: `⏰ Lembrete enviado para ${recipients.length} participantes (${amount} ${rule.time_unit} antes).`,
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
    console.log("📅 [AGENDA] Worker Iniciado (Check a cada 1 min).");
    cron.schedule('* * * * *', processReminders);
};
