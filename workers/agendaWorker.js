import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { sendMessage } from '../services/baileys/sender.js';

// Cliente Supabase Service Role (Bypassa RLS)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Helper para formatar telefone
const cleanPhone = (phone) => phone.replace(/\D/g, '');

// Helper para encontrar sessão ativa da empresa
const getSessionId = async (companyId) => {
    const { data } = await supabase.from('instances')
        .select('session_id')
        .eq('company_id', companyId)
        .eq('status', 'connected')
        .limit(1)
        .maybeSingle();
    return data?.session_id;
};

/**
 * Worker de Automação de Agenda
 * Verifica a cada 5 minutos se existem agendamentos próximos para enviar lembretes.
 */
export const startAgendaWorker = () => {
    console.log("⏰ [Agenda Worker] Serviço de notificações agendadas iniciado.");
    
    // Executa a cada 5 minutos
    cron.schedule('*/5 * * * *', async () => {
        try {
            const now = new Date();
            // Busca agendamentos nas próximas 24h que ainda não foram notificados
            // Isso cobre lembretes de "1 hora antes", "30 min antes", etc.
            const limit = new Date(now.getTime() + 24 * 60 * 60 * 1000); 

            // 1. Buscar agendamentos confirmados e pendentes de lembrete
            const { data: appointments, error } = await supabase
                .from('appointments')
                .select(`
                    id, start_time, title, company_id, user_id,
                    leads (id, name, phone),
                    companies (name)
                `)
                .eq('status', 'confirmed')
                .eq('reminder_sent', false) // Importante: Idempotência
                .gte('start_time', now.toISOString())
                .lte('start_time', limit.toISOString());

            if (error) {
                console.error("❌ [Agenda Worker] Erro query:", error.message);
                return;
            }

            if (!appointments || appointments.length === 0) return;

            console.log(`⏰ [Agenda Worker] Analisando ${appointments.length} agendamentos futuros...`);

            for (const app of appointments) {
                if (!app.leads || !app.leads.phone) continue;

                // 2. Buscar Regras de Notificação do Dono da Agenda
                const { data: rules } = await supabase
                    .from('availability_rules')
                    .select('notification_config')
                    .eq('user_id', app.user_id)
                    .eq('company_id', app.company_id)
                    .eq('is_active', true)
                    .limit(1)
                    .maybeSingle();

                if (!rules || !rules.notification_config) continue;

                const config = rules.notification_config;
                const leadNotifs = config.lead_notifications || [];

                // 3. Verificar Gatilhos (before_event)
                for (const trigger of leadNotifs) {
                    if (trigger.type === 'before_event' && trigger.active) {
                        const timeAmount = parseInt(trigger.time_amount);
                        const timeUnit = trigger.time_unit || 'minutes';
                        
                        const appTime = new Date(app.start_time).getTime();
                        let triggerTime = appTime;

                        // Calcula o momento do disparo
                        if (timeUnit === 'minutes') triggerTime -= timeAmount * 60 * 1000;
                        if (timeUnit === 'hours') triggerTime -= timeAmount * 60 * 60 * 1000;
                        if (timeUnit === 'days') triggerTime -= timeAmount * 24 * 60 * 60 * 1000;

                        // Verifica janela de disparo (com tolerância de 15 min atrasado para não perder cron)
                        const diff = now.getTime() - triggerTime;
                        
                        // Lógica de janela: Deve ter passado da hora do trigger (diff >= 0)
                        // MAS não pode ter passado muito tempo (ex: 15 min), senão é mensagem velha
                        if (diff >= 0 && diff < 15 * 60 * 1000) {
                            
                            // A. Resolve Sessão WhatsApp
                            const sessionId = await getSessionId(app.company_id);
                            if (!sessionId) continue;

                            // B. Formata Dados
                            const dateObj = new Date(app.start_time);
                            const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
                            const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);

                            // C. Processa Template
                            let msg = trigger.template
                                .replace('[lead_name]', app.leads.name.split(' ')[0])
                                .replace('[lead_phone]', app.leads.phone)
                                .replace('[empresa]', app.companies?.name || 'Empresa')
                                .replace('[data]', dateStr)
                                .replace('[hora]', timeStr);

                            // D. Envia
                            const leadPhone = cleanPhone(app.leads.phone);
                            console.log(`🚀 [Agenda Worker] Enviando lembrete para ${leadPhone}`);
                            
                            await sendMessage(sessionId, `${leadPhone}@s.whatsapp.net`, {
                                text: msg
                            });

                            // E. Marca como Enviado
                            await supabase.from('appointments')
                                .update({ reminder_sent: true })
                                .eq('id', app.id);
                            
                            break; // Evita múltiplos disparos para o mesmo evento no mesmo loop
                        }
                    }
                }
            }

        } catch (e) {
            console.error("❌ [Agenda Worker] Falha crítica:", e);
        }
    });
};
