
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
        return { success: true, appointmentId: data.id, message: "Agendamento confirmado no sistema." };
    } catch (e) {
        console.error("[TOOL] Erro ao agendar:", e);
        return { success: false, error: "Falha ao criar agendamento no banco de dados." };
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

        return { success: true, message: "Transferência realizada e relatório enviado." };

    } catch (e) {
        console.error("[TOOL] Erro no handoff:", e);
        return { success: false, error: e.message };
    }
};
