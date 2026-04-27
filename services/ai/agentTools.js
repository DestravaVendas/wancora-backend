import { createClient } from "@supabase/supabase-js";
import { sendMessage } from "../baileys/sender.js";
import { getSessionId } from "../../controllers/whatsappController.js";
import { normalizeJid } from "../../utils/wppParsers.js";
import { getDriveClient } from "../../utils/googleDrive.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Ferramenta: Buscar Arquivos no Google Drive
 */
export const searchFiles = async (companyId, query) => {
    try {
        // 1. Tenta buscar no cache do Supabase primeiro (Fuzzy Search)
        const { data: cachedFiles, error: rpcError } = await supabase.rpc('search_drive_files', {
            p_company_id: companyId,
            p_query: query,
            p_limit: 5
        });

        if (!rpcError && cachedFiles && cachedFiles.length > 0) {
            return { 
                success: true, 
                message: "Encontrei estes arquivos no Drive:",
                files: cachedFiles.map(f => ({ id: f.google_id, name: f.name, type: f.mime_type }))
            };
        }

        // 2. Fallback: Busca direta na API do Google Drive
        const drive = await getDriveClient(companyId);
        if (!drive) return { success: false, error: "Integração com Google Drive não configurada ou expirada." };

        const res = await drive.files.list({
            q: `name contains '${query}' and trashed = false`,
            fields: 'files(id, name, mimeType, webViewLink)',
            pageSize: 5
        });

        if (!res.data.files || res.data.files.length === 0) {
            return { success: true, message: "Não encontrei nenhum arquivo com esse nome no Drive." };
        }

        return { 
            success: true, 
            message: "Encontrei estes arquivos no Drive:",
            files: res.data.files.map(f => ({ id: f.id, name: f.name, type: f.mimeType }))
        };

    } catch (e) {
        console.error("[TOOL] Erro ao buscar arquivos:", e);
        return { success: false, error: "Falha técnica ao acessar o Google Drive." };
    }
};

/**
 * Ferramenta: Enviar Arquivo do Google Drive via WhatsApp
 */
export const sendFile = async (companyId, remoteJid, googleId) => {
    try {
        const drive = await getDriveClient(companyId);
        if (!drive) return { success: false, error: "Integração com Google Drive não configurada." };

        // 1. Busca metadados do arquivo
        const fileMetadata = await drive.files.get({
            fileId: googleId,
            fields: 'id, name, mimeType'
        });

        const { name, mimeType } = fileMetadata.data;

        // 2. Baixa o conteúdo do arquivo
        const res = await drive.files.get(
            { fileId: googleId, alt: 'media' },
            { responseType: 'arraybuffer' }
        );

        const buffer = Buffer.from(res.data);

        // 3. Envia via Baileys
        const sessionId = await getSessionId(companyId);
        if (!sessionId) return { success: false, error: "Sessão do WhatsApp não encontrada." };

        await sendMessage({
            sessionId,
            to: remoteJid,
            type: 'document',
            content: buffer,
            fileName: name,
            mimetype: mimeType
        });

        return { success: true, message: `Arquivo '${name}' enviado com sucesso para o cliente.` };

    } catch (e) {
        console.error("[TOOL] Erro ao enviar arquivo:", e);
        return { success: false, error: "Falha ao baixar ou enviar o arquivo do Google Drive." };
    }
};

/**
 * Ferramenta: Agendar Reunião
 */
export const scheduleMeeting = async (companyId, leadId, title, dateISO, description, userId) => {
    try {
        const safeDate = new Date(dateISO);
        if (!dateISO || isNaN(safeDate.getTime())) {
            console.error("[TOOL] scheduleMeeting recebeu data inválida:", dateISO);
            return { success: false, error: "A data informada no agendamento é inválida. Por favor, forneça o parâmetro 'dateISO' com uma data e hora válidas (ex: YYYY-MM-DDTHH:mm:ss)." };
        }

        const endTime = new Date(safeDate.getTime() + 30 * 60000);

        const { data, error } = await supabase.from('appointments').insert({
            company_id: companyId,
            user_id: userId, // Dono do lead ou admin
            lead_id: leadId,
            title: title || 'Reunião Agendada via IA',
            description: description || 'Agendamento automático.',
            start_time: safeDate.toISOString(),
            end_time: endTime.toISOString(), // Padrão 30min
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
        await supabase.from('leads').update({ bot_status: 'paused' }).eq('id', leadId).eq('company_id', companyId);

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
        const safeDate = new Date(dateISO);
        if (!dateISO || isNaN(safeDate.getTime())) {
            return { success: false, error: "Data inválida para checagem da agenda. Use o fomato ISO 8601 (ex: YYYY-MM-DD)." };
        }

        const startOfDay = new Date(safeDate);
        startOfDay.setHours(0, 0, 0, 0);
        
        const endOfDay = new Date(safeDate);
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
