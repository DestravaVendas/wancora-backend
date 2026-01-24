
import { createClient } from "@supabase/supabase-js";
import { startSession as startService, deleteSession as deleteService, sessions } from '../services/baileys/connection.js';
import { sendMessage as sendService } from '../services/baileys/sender.js';
import { savePollVote, normalizeJid } from '../services/crm/sync.js'; // Importei normalizeJid

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

// --- FIX: Votar em Enquete (Protocolo Baileys v6+) ---
export const sendPollVote = async (sessionId, companyId, remoteJid, pollId, optionId) => {
    try {
        const session = sessions.get(sessionId);
        if (!session?.sock) throw new Error("Sessão desconectada.");

        // 1. Recuperar a mensagem original do banco para saber quais são as opções
        // O Baileys exige o TEXTO da opção para calcular o hash do voto, não apenas o índice
        const { data: pollMsg } = await supabase
            .from('messages')
            .select('whatsapp_id, from_me, content')
            .eq('id', pollId) 
            .single();

        if (!pollMsg) throw new Error("Enquete não encontrada no banco.");

        // 2. Parsing Robusto do Conteúdo
        let pollContent;
        try {
            // Tenta parsear JSON, se falhar assume que é objeto se já vier assim
            pollContent = typeof pollMsg.content === 'string' ? JSON.parse(pollMsg.content) : pollMsg.content;
        } catch (e) {
            console.error("Erro parse poll:", e);
            throw new Error("Conteúdo da enquete corrompido ou inválido.");
        }

        // Validação da estrutura
        if (!pollContent || !Array.isArray(pollContent.options)) {
            throw new Error("Estrutura da enquete inválida no banco.");
        }

        // 3. Extrair a Opção exata (Texto)
        const selectedOptionText = pollContent.options[optionId];
        
        if (selectedOptionText === undefined || selectedOptionText === null) {
            throw new Error(`Opção inválida (Index: ${optionId}). Opções disponíveis: ${pollContent.options.length}`);
        }

        console.log(`🗳️ [VOTE] Votando em: "${selectedOptionText}" (Index: ${optionId})`);

        // FIX CRÍTICO: Normalizar JID para garantir match da chave
        const chatJid = normalizeJid(remoteJid); 
        
        // 4. Enviar voto pelo Socket
        // O segredo é garantir que 'vote' exista e 'selectedOptions' seja array de strings
        const votePayload = {
            poll: {
                vote: {
                    key: {
                        id: pollMsg.whatsapp_id,
                        remoteJid: chatJid,
                        fromMe: pollMsg.from_me,
                        // Se for grupo, precisa do participant? O Baileys geralmente lida, mas em mensagens 'fromMe'
                        // a chave deve ser limpa.
                    },
                    selectedOptions: [String(selectedOptionText)] // Força String
                }
            }
        };

        await session.sock.sendMessage(chatJid, votePayload);

        // 5. Salvar voto no banco localmente (Optimistic Update)
        // Usamos o ID do bot como 'voter'
        const myJid = normalizeJid(session.sock.user?.id);
        await savePollVote({
            companyId,
            msgId: pollMsg.whatsapp_id,
            voterJid: myJid,
            optionId
        });

        return { success: true };

    } catch (error) {
        console.error(`[Controller] Erro ao votar:`, error.message);
        throw error;
    }
};

// --- Enviar Reação (Emoji) ---
export const sendReaction = async (sessionId, companyId, remoteJid, msgId, reaction) => {
    try {
        const session = sessions.get(sessionId);
        if (!session?.sock) throw new Error("Sessão desconectada.");

        // Busca mensagem alvo para pegar a Key correta (ID + fromMe)
        const { data: targetMsg } = await supabase
            .from('messages')
            .select('whatsapp_id, from_me')
            .eq('id', msgId) // ID do Supabase
            .single();

        if (!targetMsg) throw new Error("Mensagem alvo não encontrada.");

        const key = {
            remoteJid: normalizeJid(remoteJid),
            id: targetMsg.whatsapp_id,
            fromMe: targetMsg.from_me
        };

        // Envia reação via Socket
        await session.sock.sendMessage(normalizeJid(remoteJid), {
            react: {
                text: reaction, // Emoji ou '' para remover
                key: key
            }
        });

        return { success: true };
    } catch (error) {
        console.error(`[Controller] Erro ao reagir:`, error);
        throw error;
    }
};

// --- Deletar Mensagem (Revoke) ---
export const deleteMessage = async (sessionId, companyId, remoteJid, msgId, everyone = false) => {
    try {
        // 1. Apagar do Banco (Delete for me & everyone)
        // Marcamos como deletada visualmente primeiro
        await supabase.from('messages')
            .update({ is_deleted: true, content: '🚫 Mensagem apagada' })
            .eq('id', msgId)
            .eq('company_id', companyId);

        // 2. Se for para todos, enviar protocolo de REVOKE no WhatsApp
        if (everyone) {
            const session = sessions.get(sessionId);
            if (session?.sock) {
                const { data: targetMsg } = await supabase
                    .from('messages')
                    .select('whatsapp_id, from_me')
                    .eq('id', msgId)
                    .single();

                if (targetMsg) {
                    const key = {
                        remoteJid: normalizeJid(remoteJid),
                        id: targetMsg.whatsapp_id,
                        fromMe: targetMsg.from_me 
                    };
                    await session.sock.sendMessage(normalizeJid(remoteJid), { delete: key });
                }
            }
        }

        return { success: true };
    } catch (error) {
        console.error(`[Controller] Erro ao deletar:`, error);
        throw error;
    }
};

export const getSessionId = async (companyId) => {
    try {
        const { data, error } = await supabase
            .from('instances')
            .select('session_id')
            .eq('company_id', companyId)
            .eq('status', 'connected')
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        
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
