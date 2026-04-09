
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
    // Tratamento BR básico
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

// Helper de Replace de Variáveis
// FIX: Agora aceita 'rule' para pegar defaults configurados no Frontend e TIMEZONE
const formatMessage = (template, app, rule, recipientName, recipientPhone) => {
    if (!template) return "";
    
    const dateObj = new Date(app.start_time);
    
    // FIX DE HORÁRIO: Usa o timezone configurado ou padrão SP
    const timeZone = rule?.timezone || 'America/Sao_Paulo';

    const dateStr = new Intl.DateTimeFormat('pt-BR', { 
        day: '2-digit', 
        month: '2-digit', 
        timeZone 
    }).format(dateObj);

    const timeStr = new Intl.DateTimeFormat('pt-BR', { 
        hour: '2-digit', 
        minute: '2-digit', 
        timeZone 
    }).format(dateObj);

    // Prioridade: Dado do Evento > Dado da Configuração Global > Fallback
    const location = app.event_location_details || rule?.event_location_details || app.category || 'Online';
    const link = app.meet_link || rule?.meeting_url || '';
    const companyName = app.companies?.name || '';

    return template
        .replace(/\[nome_do_lead\]/g, recipientName || 'Cliente')
        .replace(/\[lead_name\]/g, recipientName || 'Cliente')
        .replace(/\[lead_phone\]/g, recipientPhone || '')
        .replace(/\[data\]/g, dateStr)
        .replace(/\[hora\]/g, timeStr)
        .replace(/\[local\]/g, location) 
        .replace(/\[link_reuniao\]/g, link)
        .replace(/\[link\]/g, link) 
        .replace(/\[empresa\]/g, companyName);
};

const processReminders = async () => {
    const redis = getRedisClient();
    const LOCK_KEY = 'worker:agenda:lock';
    // TTL Ajustado: 55s (Para rodar a cada minuto sem colisão)
    const LOCK_TTL = 55; 

    try {
        // Mutex Distribuído (Redis)
        if (redis) {
            const acquired = await redis.set(LOCK_KEY, 'LOCKED', 'EX', LOCK_TTL, 'NX');
            if (!acquired) return; // Já tem outro worker rodando
        }

        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        // ============================================================
        // FLUXO 1: CONFIRMAÇÕES PENDENTES (ON_BOOKING)
        // Busca agendamentos recentes que ainda não tiveram aviso de confirmação enviado.
        // ============================================================
        
        // Janela de busca: últimas 24h (para garantir que pegue mesmo se o server ficou off um tempo)
        const lookbackWindow = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        const { data: newBookings } = await supabase
            .from('appointments')
            .select(`
                *,
                leads (id, name, phone),
                companies (name),
                availability_rules (notification_config, meeting_url, event_location_details, timezone)
            `)
            .eq('confirmation_sent', false) // CRÍTICO: Ainda não enviado
            .gte('created_at', lookbackWindow.toISOString()) 
            .neq('status', 'cancelled'); // Ignora cancelados

        if (newBookings && newBookings.length > 0) {
            console.log(`📅 [Agenda Worker] Processando ${newBookings.length} confirmações pendentes.`);
            
            for (const app of newBookings) {
                // A. Resolver Configuração (Prioridade: Custom > Regra de Disponibilidade)
                let config = app.custom_notification_config;
                let ruleData = app.availability_rules; // Pega dados da regra (Link/Local/Timezone)
                
                if (!config && ruleData?.notification_config) {
                    config = ruleData.notification_config;
                }
                
                // Fallback: Busca regra padrão ativa da empresa se não achou no join
                if (!config) {
                     const { data: rules } = await supabase.from('availability_rules')
                        .select('notification_config, meeting_url, event_location_details, timezone')
                        .eq('company_id', app.company_id)
                        .eq('is_active', true)
                        .limit(1);
                     
                     if (rules && rules.length > 0) {
                        config = rules[0].notification_config;
                        ruleData = rules[0];
                     }
                }

                // Se não tiver config ou notificações desativadas no evento, marca como enviado para sair da fila
                if (!config || app.send_notifications === false) {
                    await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', app.id);
                    continue;
                }

                // B. Resolver Sessão
                const sessionId = await resolveSession(app.company_id, config.sending_session_id);
                if (!sessionId) {
                    // Sem sessão online. Pula este ciclo e tenta no próximo (não marca confirmation_sent).
                    // Isso garante retry automático.
                    continue;
                }

                // C. Construir Lista de Destinatários (Lead + Convidados)
                const recipients = [];
                // 1. Lead Principal
                if (app.leads?.phone) {
                    recipients.push({ name: app.leads.name, phone: app.leads.phone });
                }
                // 2. Convidados Manuais (JSONB)
                if (app.guests && Array.isArray(app.guests)) {
                    app.guests.forEach(g => {
                        const p = cleanPhone(g.phone);
                        // Evita duplicatas se o convidado for o próprio lead
                        if (p && !recipients.find(r => cleanPhone(r.phone) === p)) {
                            recipients.push({ name: g.name, phone: g.phone });
                        }
                    });
                }

                // D. Disparos

                // --- 1. Para Clientes/Convidados (On Booking) ---
                const leadTrigger = config.lead_notifications?.find(n => n.type === 'on_booking' && n.active);
                if (leadTrigger && recipients.length > 0) {
                     for (const r of recipients) {
                         const phone = cleanPhone(r.phone);
                         if(phone) {
                             // 🛡️ [FIX] Resolve JID se o telefone for um LID
                             let targetJid = `${phone}@s.whatsapp.net`;
                             if (phone.length > 13) {
                                 // Pode ser um LID. Tenta resolver via identity_map
                                 const { data: mapData } = await supabase
                                     .from('identity_map')
                                     .select('phone_jid')
                                     .eq('lid_jid', `${phone}@lid`)
                                     .eq('company_id', app.company_id)
                                     .maybeSingle();
                                 
                                 if (mapData?.phone_jid) {
                                     targetJid = mapData.phone_jid;
                                 } else {
                                     // Se não resolveu, tenta enviar como @lid se parecer um LID
                                     targetJid = `${phone}@lid`;
                                 }
                             }

                             const msg = formatMessage(leadTrigger.template, app, ruleData, r.name, r.phone);
                             await sendMessage({ 
                                 sessionId, 
                                 to: targetJid, 
                                 type: 'text', 
                                 content: msg, 
                                 companyId: app.company_id 
                             }).catch(e => console.error(`[Agenda] Falha envio para ${targetJid}:`, e.message));
                         }
                     }
                }

                // --- 2. Para Admin (On Booking) ---
                const adminTrigger = config.admin_notifications?.find(n => n.type === 'on_booking' && n.active);
                if (adminTrigger && config.admin_phone) {
                    const adminPhone = cleanPhone(config.admin_phone);
                    if (adminPhone) {
                        // 🛡️ [FIX] Resolve JID se o telefone do admin for um LID
                        let adminJid = `${adminPhone}@s.whatsapp.net`;
                        if (adminPhone.length > 13) {
                            const { data: mapData } = await supabase
                                .from('identity_map')
                                .select('phone_jid')
                                .eq('lid_jid', `${adminPhone}@lid`)
                                .eq('company_id', app.company_id)
                                .maybeSingle();
                            
                            if (mapData?.phone_jid) {
                                adminJid = mapData.phone_jid;
                            } else {
                                adminJid = `${adminPhone}@lid`;
                            }
                        }

                        const mainLeadName = app.leads?.name || recipients[0]?.name || 'Cliente';
                        const msg = formatMessage(adminTrigger.template, app, ruleData, mainLeadName, app.leads?.phone || '');
                        
                        await sendMessage({ 
                            sessionId, 
                            to: adminJid, 
                            type: 'text', 
                            content: msg, 
                            companyId: app.company_id 
                        }).catch(e => console.error(`[Agenda] Falha envio admin para ${adminJid}:`, e.message));
                    }
                }

                // E. Conclusão: Marca como processado
                await supabase.from('appointments').update({ confirmation_sent: true }).eq('id', app.id);
            }
        }

        // ============================================================
        // FLUXO 2: LEMBRETES PROGRAMADOS (BEFORE_EVENT)
        // Busca agendamentos confirmados nas próximas 24h que ainda não tiveram lembrete enviado.
        // ============================================================
        const { data: reminders } = await supabase
            .from('appointments')
            .select(`
                *,
                leads (id, name, phone),
                companies (name),
                availability_rules (notification_config, meeting_url, event_location_details, timezone)
            `)
            .eq('status', 'confirmed')
            .eq('reminder_sent', false)
            .eq('send_notifications', true) // Respeita toggle manual
            .gte('start_time', now.toISOString())
            .lte('start_time', tomorrow.toISOString());

        if (reminders && reminders.length > 0) {
            for (const app of reminders) {
                // Lógica de Config similar ao fluxo acima
                let config = app.custom_notification_config;
                let ruleData = app.availability_rules;

                if (!config && ruleData?.notification_config) {
                    config = ruleData.notification_config;
                }

                if(!config) {
                     const { data: rules } = await supabase.from('availability_rules')
                        .select('notification_config, meeting_url, event_location_details, timezone')
                        .eq('company_id', app.company_id)
                        .limit(1);
                     
                     if (rules && rules.length > 0) {
                         config = rules[0].notification_config;
                         ruleData = rules[0];
                     }
                }

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

                // Filtra regras de "Antes do Evento"
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

                    // Margem de tolerância: 2 minutos (Worker roda a cada 1 min)
                    // Dispara se: Agora está dentro da janela de tempo (ex: 59min 30s para regra de 1h)
                    const margin = 2 * 60 * 1000; 

                    if (timeUntil <= ruleTimeMs && timeUntil > (ruleTimeMs - margin)) {
                        
                        const sessionId = await resolveSession(app.company_id, config.sending_session_id);
                        if (!sessionId) continue; // Tenta no próximo minuto se reconectar

                        for (const r of recipients) {
                            const leadPhone = cleanPhone(r.phone);
                            if (!leadPhone) continue;

                            // 🛡️ [FIX] Resolve JID se o telefone for um LID
                            let targetJid = `${leadPhone}@s.whatsapp.net`;
                            if (leadPhone.length > 13) {
                                const { data: mapData } = await supabase
                                    .from('identity_map')
                                    .select('phone_jid')
                                    .eq('lid_jid', `${leadPhone}@lid`)
                                    .eq('company_id', app.company_id)
                                    .maybeSingle();
                                
                                if (mapData?.phone_jid) {
                                    targetJid = mapData.phone_jid;
                                } else {
                                    targetJid = `${leadPhone}@lid`;
                                }
                            }

                            const msg = formatMessage(rule.template, app, ruleData, r.name, r.phone);
                            
                            try {
                                await sendMessage({
                                    sessionId,
                                    to: targetJid,
                                    type: 'text',
                                    content: msg,
                                    companyId: app.company_id
                                });
                                // 🛡️ Pequena pausa entre lembretes do mesmo minuto para não "metralhar" a fila
                                await new Promise(res => setTimeout(res, Math.random() * 2000 + 1000));
                            } catch (sendError) {
                                console.error(`❌ [Agenda] Falha envio lembrete para ${targetJid}:`, sendError.message);
                            }
                        }

                        // Marca como enviado. 
                        // Nota: Se houver múltiplos lembretes (ex: 1h antes E 10min antes), isso marcaria tudo como enviado
                        // Para suportar múltiplos avisos no mesmo evento, precisaríamos de uma estrutura de controle mais complexa.
                        // Nesta versão, assumimos que o lembrete principal foi enviado.
                        await supabase.from('appointments').update({ reminder_sent: true }).eq('id', app.id);
                        
                        // Log de atividade
                        if (app.leads?.id) {
                            await supabase.from('lead_activities').insert({
                                company_id: app.company_id,
                                lead_id: app.leads.id,
                                type: 'log',
                                content: `⏰ Lembrete automático enviado para ${recipients.length} participantes (${amount} ${rule.time_unit} antes).`,
                                created_by: app.user_id, // Atribui ao dono do agendamento
                                created_at: new Date()
                            });
                        }
                        
                        break; // Evita disparar duas regras conflitantes no mesmo minuto
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
