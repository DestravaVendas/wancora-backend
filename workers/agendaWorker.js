
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
    const LOCK_TTL = 290; // 4 minutos e 50 segundos (pouco menos que o intervalo do cron)

    try {
        // 1. Tenta adquirir o Lock (Atomicamente)
        if (redis) {
            const acquired = await redis.set(LOCK_KEY, 'LOCKED', 'EX', LOCK_TTL, 'NX');
            if (!acquired) {
                console.warn('🔒 [Agenda Worker] Execução anterior ainda ativa. Pulando ciclo.');
                return;
            }
        }

        console.log('⏰ [Agenda Worker] Verificando lembretes pendentes...');
        
        // 1. Busca agendamentos das próximas 24h que ainda não foram notificados
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        
        const { data: appointments, error } = await supabase
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

        if (error) throw error;
        if (!appointments || appointments.length === 0) {
            console.log(`💤 [Agenda Worker] Nenhum lembrete pendente.`);
            return;
        }

        console.log(`🔍 [Agenda Worker] ${appointments.length} agendamentos futuros encontrados.`);

        for (const app of appointments) {
            // Regras de Notificação
            const config = app.availability_rules?.notification_config;
            
            // Se não tem config ou não tem lead vinculado, pula
            if (!config || !config.lead_notifications || !app.leads?.phone) continue;

            const leadReminders = config.lead_notifications.filter(n => n.type === 'before_event' && n.active);
            if (leadReminders.length === 0) continue;

            const appTime = new Date(app.start_time).getTime();
            const timeUntil = appTime - now.getTime();
            
            // Verifica cada regra de tempo (Ex: 1 hora antes)
            for (const rule of leadReminders) {
                // Converte tempo da regra para ms
                let ruleTimeMs = 0;
                const amount = Number(rule.time_amount);
                if (rule.time_unit === 'minutes') ruleTimeMs = amount * 60 * 1000;
                else if (rule.time_unit === 'hours') ruleTimeMs = amount * 60 * 60 * 1000;
                else if (rule.time_unit === 'days') ruleTimeMs = amount * 24 * 60 * 60 * 1000;

                // Margem de erro de 10 minutos (devido ao cron rodar a cada 5/10 min)
                const margin = 10 * 60 * 1000;

                // Se está na hora de enviar (timeUntil está dentro da janela do ruleTime +/- margem)
                // Ex: Faltam 58min, regra é 60min. (60-58 = 2min < 10min). Envia.
                // Mas precisamos garantir que não enviamos muito cedo.
                // Lógica simples: Se timeUntil <= ruleTimeMs E timeUntil > ruleTimeMs - margin
                
                if (timeUntil <= ruleTimeMs && timeUntil > (ruleTimeMs - margin)) {
                    
                    // A. Resolve Sessão
                    const sessionId = await getSessionId(app.company_id);
                    if (!sessionId) {
                        console.warn(`⚠️ [Agenda Worker] Sem sessão para empresa ${app.company_id}`);
                        continue;
                    }

                    // B. Prepara Mensagem
                    const dateObj = new Date(app.start_time);
                    const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
                    const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);

                    let msg = rule.template
                        .replace('[lead_name]', app.leads.name || 'Cliente')
                        .replace('[empresa]', app.companies?.name || '')
                        .replace('[data]', dateStr)
                        .replace('[hora]', timeStr);

                    // C. Envia
                    const leadPhone = cleanPhone(app.leads.phone);
                    console.log(`🚀 [Agenda Worker] Enviando lembrete para ${leadPhone}`);
                    
                    try {
                        await sendMessage({
                            sessionId,
                            to: `${leadPhone}@s.whatsapp.net`,
                            type: 'text',
                            content: msg
                        });

                        // D. Marca como Enviado
                        await supabase.from('appointments')
                            .update({ reminder_sent: true })
                            .eq('id', app.id);
                        
                        // E. Log
                        await supabase.from('lead_activities').insert({
                            company_id: app.company_id,
                            lead_id: app.leads.id,
                            type: 'log',
                            content: `⏰ Lembrete Automático enviado (${amount} ${rule.time_unit} antes).`,
                            created_by: app.user_id, // Atribui ao dono da agenda
                            created_at: new Date()
                        });

                    } catch (sendError) {
                        console.error(`❌ [Agenda Worker] Erro no envio:`, sendError.message);
                    }
                    
                    break; // Sai do loop de regras para este appointment (evita flood de múltiplos lembretes no mesmo tick)
                }
            }
        }

    } catch (e) {
        console.error("❌ [Agenda Worker] Falha crítica:", e);
    } finally {
        // Libera o Lock se tiver terminado antes do TTL
        if (redis) {
            await redis.del(LOCK_KEY);
        }
    }
};

export const startAgendaWorker = () => {
    console.log("📅 [AGENDA] Worker de Notificações Iniciado (Check a cada 5 min).");
    // Roda a cada 5 minutos
    cron.schedule('*/5 * * * *', processReminders);
};
