
import { createClient } from "@supabase/supabase-js";
import { startSession as startService, deleteSession as deleteService, sessions } from '../services/baileys/connection.js';
import { sendMessage as sendService } from '../services/baileys/sender.js';
import { savePollVote } from '../services/crm/sync.js';

// Cliente Supabase para consultas auxiliares (Service Role ou Anon, depende do env, mas para leitura OK)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

/**
 * Wancora CRM - WhatsApp Controller (Facade)
 */

// Inicia uma sessão (Proxy para connection.js)
export const startSession = async (sessionId, companyId) => {
    try {
        console.log(`[Controller] Solicitando início da sessão ${sessionId}`);
        return await startService(sessionId, companyId);
    } catch (error) {
        console.error(`[Controller] Erro ao iniciar sessão:`, error);
        throw error;
    }
};

// Encerra uma sessão (Proxy para connection.js)
export const deleteSession = async (sessionId, companyId) => {
    try {
        console.log(`[Controller] Solicitando remoção da sessão ${sessionId}`);
        return await deleteService(sessionId);
    } catch (error) {
        console.error(`[Controller] Erro ao deletar sessão:`, error);
        throw error;
    }
};

// Envia mensagem (Proxy para sender.js)
export const sendMessage = async (sessionId, to, payload) => {
    try {
        const unifiedPayload = {
            sessionId,
            to,
            ...payload 
        };
        return await sendService(unifiedPayload);
    } catch (error) {
        console.error(`[Controller] Erro ao enviar mensagem:`, error);
        throw error; 
    }
};

// --- NOVO: Votar em Enquete ---
export const sendPollVote = async (sessionId, companyId, remoteJid, pollId, optionId) => {
    try {
        const session = sessions.get(sessionId);
        if (!session?.sock) throw new Error("Sessão desconectada.");

        // 1. Recuperar a mensagem original do banco para pegar os hashes das opções
        // PORM, o Baileys exige a chave da mensagem original (pollCreationMessage).
        const { data: pollMsg } = await supabase
            .from('messages')
            .select('whatsapp_id, from_me, content')
            .eq('id', pollId) // pollId aqui é o ID do Supabase da mensagem
            .single();

        if (!pollMsg) throw new Error("Enquete não encontrada no banco.");

        // Reconstruir a chave original do Baileys
        const originalKey = {
            remoteJid: remoteJid,
            id: pollMsg.whatsapp_id,
            fromMe: pollMsg.from_me
        };

        // Extrair o conteúdo da enquete para saber os metadados
        const pollContent = JSON.parse(pollMsg.content);
        
        // Enviar voto pelo Socket
        await session.sock.sendMessage(remoteJid, {
            poll: {
                key: originalKey,
                vote: {
                    singleSelect: pollContent.selectableOptionsCount === 1,
                    selectedOptions: [optionId] // Baileys moderno lida com index se configurado corretamente ou tentamos hash
                }
            }
        });

        // Salvar voto no banco localmente (Optimistic)
        const myJid = session.sock.user.id.split(':')[0] + '@s.whatsapp.net';
        await savePollVote({
            companyId,
            msgId: pollMsg.whatsapp_id,
            voterJid: myJid,
            optionId
        });

        return { success: true };

    } catch (error) {
        console.error(`[Controller] Erro ao votar:`, error);
        throw error;
    }
};

/**
 * Recupera o sessionId ativo de uma empresa para uso em Workers/Background Jobs.
 * Prioriza sessões marcadas como 'connected'.
 */
export const getSessionId = async (companyId) => {
    try {
        // Busca sessão ativa no banco
        const { data, error } = await supabase
            .from('instances')
            .select('session_id')
            .eq('company_id', companyId)
            .eq('status', 'connected')
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        
        // Se não achar conectada, tenta pegar qualquer uma (fallback)
        if (!data) {
             const { data: anySession } = await supabase
                .from('instances')
                .select('session_id')
                .eq('company_id', companyId)
                .limit(1)
                .maybeSingle();
             return anySession?.session_id || null;
        }

        return data.session_id;
    } catch (error) {
        console.error(`[Controller] Erro ao buscar sessionId para empresa ${companyId}:`, error);
        return null;
    }
};
