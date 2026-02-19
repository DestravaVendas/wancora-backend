import { createClient } from "@supabase/supabase-js";
import { sendMessage } from "../baileys/sender.js";
import { getSessionId } from "../../controllers/whatsappController.js";
import { normalizeJid } from "../../utils/wppParsers.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Ferramenta: Agendar Reunião
 */
export const scheduleMeeting = async (companyId, leadId, title, dateISO, description, userId) => {
    try {
        const { data, error } = await supabase.from('appointments').insert({
            company_id: companyId,
            user_id: userId, // Dono do lead ou admin
            lead_id: leadId,
            title: title || 'Reunião Agendada via IA',
            description: description || 'Agendamento automático.',
            start_time: dateISO,
            end_time: new Date(new Date(dateISO).getTime() + 30 * 60000).toISOString(), // Padrão 30min
            status: 'confirmed',
            is_task: false,
            origin: 'ai_agent'
        }).select().single();

        if (error) throw error;
        return { success: true, appointmentId: data.id, message: "Agendamento confirmado no sistema com sucesso." };
    } catch (e) {
        console.error("[TOOL] Erro ao agendar:", e);
        return { success: false, error: "Falha ao criar agendamento no banco de dados. Informe ao cliente que houve um erro técnico." };
    }
};

/**
 * Ferramenta: Transferir para Humano e Enviar Relatório
 */
export const handoffAndReport = async (companyId, leadId, remoteJid, summary, reason, reportingPhones) => {
    try {
        // 1. Pausa o Bot
        await supabase.from('leads').update({ bot_status: 'paused' }).eq('id', leadId);

        // 2. Notifica o Cliente
        const sessionId = await getSessionId(companyId);
        if (sessionId) {
            await sendMessage({
                sessionId,
                to: remoteJid,
                type: 'text',
                content: "Estou transferindo seu atendimento para um especialista humano. Um momento, por favor."
            });
        }

        // 3. Envia Relatório para os Gestores (Se configurado)
        if (reportingPhones && Array.isArray(reportingPhones) && reportingPhones.length > 0) {
            const reportMsg = `🚨 *HANDOFF DE IA - RELATÓRIO*\n\n` +
                `*Motivo:* ${reason}\n` +
                `*Resumo da Conversa:* ${summary}\n` +
                `*Link do Chat:* /chat?jid=${remoteJid}`;

            for (const phone of reportingPhones) {
                const adminJid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
                if (sessionId) {
                    await sendMessage({
                        sessionId,
                        to: adminJid,
                        type: 'text',
                        content: reportMsg
                    }).catch(e => console.error("Erro ao enviar relatório:", e));
                }
            }
        }

        return { success: true, message: "Transferência realizada e relatório enviado. O atendimento humano assumiu." };

    } catch (e) {
        console.error("[TOOL] Erro no handoff:", e);
        return { success: false, error: e.message };
    }
};

/**
 * Ferramenta (NOVA): Consultar Disponibilidade da Agenda
 * Retorna os horários já OCUPADOS no dia solicitado para a IA não alucinar.
 */
export const checkAvailability = async (companyId, dateISO) => {
    try {
        const startOfDay = new Date(dateISO);
        startOfDay.setHours(0, 0, 0, 0);
        
        const endOfDay = new Date(dateISO);
        endOfDay.setHours(23, 59, 59, 999);

        const { data, error } = await supabase
            .from('appointments')
            .select('start_time, end_time, title')
            .eq('company_id', companyId)
            .eq('status', 'confirmed') // Só pega os confirmados
            .gte('start_time', startOfDay.toISOString())
            .lte('start_time', endOfDay.toISOString())
            .order('start_time', { ascending: true });

        if (error) throw error;

        // Se não tiver nada, o dia está todo livre
        if (!data || data.length === 0) {
            return { success: true, message: "A agenda está TOTALMENTE LIVRE neste dia. Você pode oferecer qualquer horário comercial (ex: 09h às 18h)." };
        }

        // Retorna os slots ocupados para a IA desviar deles
        const occupiedSlots = data.map(app => ({
            inicio: new Date(app.start_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute:'2-digit' }),
            fim: new Date(app.end_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute:'2-digit' })
        }));

        return { 
            success: true, 
            message: "ATENÇÃO: A agenda possui os seguintes horários OCUPADOS neste dia. Você DEVE oferecer horários diferentes destes.",
            occupied_slots: occupiedSlots
        };

    } catch (e) {
        console.error("[TOOL] Erro ao checar agenda:", e);
        return { success: false, error: "Falha ao consultar o banco de dados da agenda." };
    }
};
