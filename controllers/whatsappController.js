
import { createClient } from "@supabase/supabase-js";
import { startSession as startService, deleteSession as deleteService, sessions } from '../services/baileys/connection.js';
import { sendMessage as sendService } from '../services/baileys/sender.js';
import { savePollVote, normalizeJid } from '../services/crm/sync.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const startSession = async (sessionId, companyId) => {
    try {
        console.log(`[Controller] Solicitando início da sessão ${sessionId}`);
        return await startService(sessionId, companyId);
    } catch (error) {
        console.error(`[Controller] Erro ao iniciar sessão:`, error);
        throw error;
    }
};

export const deleteSession = async (sessionId, companyId) => {
    try {
        console.log(`[Controller] Solicitando remoção da sessão ${sessionId}`);
        return await deleteService(sessionId);
    } catch (error) {
        console.error(`[Controller] Erro ao deletar sessão:`, error);
        throw error;
    }
};

export const sendMessage = async (sessionId, to, payload) => {
    try {
        const unifiedPayload = { sessionId, to, ...payload };
        return await sendService(unifiedPayload);
    } catch (error) {
        console.error(`[Controller] Erro ao enviar mensagem:`, error);
        throw error; 
    }
};

export const sendPollVote = async (sessionId, companyId, remoteJid, pollId, optionId) => {
    try {
        const session = sessions.get(sessionId);
        if (!session || !session.sock) throw new Error("Sessão desconectada.");

        // 1. Busca dados da enquete original para saber a chave e as opções
        const { data: pollMsg } = await supabase
            .from('messages')
            .select('whatsapp_id, from_me, content')
            .eq('id', pollId) 
            .single();

        if (!pollMsg) throw new Error("Enquete não encontrada no banco.");

        let pollContent;
        try {
            pollContent = typeof pollMsg.content === 'string' ? JSON.parse(pollMsg.content) : pollMsg.content;
        } catch (e) {
            console.error("Erro parse poll:", e);
            throw new Error("Conteúdo da enquete corrompido.");
        }

        // 2. Resolve a opção selecionada (Precisa do texto da opção, não só do ID)
        let optionsList = [];
        if (Array.isArray(pollContent.options)) {
            optionsList = pollContent.options.map(opt => (typeof opt === 'object' && opt.optionName) ? opt.optionName : opt);
        } else {
            throw new Error("Estrutura da enquete inválida (sem opções).");
        }

        const selectedOptionText = optionsList[optionId];
        if (selectedOptionText === undefined) {
            throw new Error(`Opção inválida: Index ${optionId} não existe.`);
        }

        console.log(`🗳️ [VOTE] Votando em: "${selectedOptionText}" (Index: ${optionId})`);

        const chatJid = normalizeJid(remoteJid);
        
        // 3. Monta o payload de VOTO para o Baileys
        // IMPORTANTE: A estrutura correta para VOTAR é enviar um objeto 'vote' dentro de 'poll'.
        // Não se deve enviar 'name' ou 'values' aqui, pois isso seria criar uma nova enquete.
        const votePayload = {
            vote: {
                key: {
                    remoteJid: chatJid,
                    id: pollMsg.whatsapp_id,
                    fromMe: pollMsg.from_me,
                },
                selectedOptions: [String(selectedOptionText)]
            }
        };

        // Envia usando a chave 'poll' mas com o conteúdo de voto formatado
        await session.sock.sendMessage(chatJid, { poll: votePayload });

        // 4. Salva no banco (Optimistic Update)
        const myJid = normalizeJid(session.sock.user?.id);
        await savePollVote({ companyId, msgId: pollMsg.whatsapp_id, voterJid: myJid, optionId });

        return { success: true };

    } catch (error) {
        console.error(`[Controller] Erro ao votar:`, error.message);
        throw error;
    }
};

export const sendReaction = async (sessionId, companyId, remoteJid, msgId, reaction) => {
    try {
        const session = sessions.get(sessionId);
        if (!session?.sock) throw new Error("Sessão desconectada.");

        const { data: targetMsg } = await supabase
            .from('messages')
            .select('whatsapp_id, from_me')
            .eq('id', msgId) 
            .single();

        if (!targetMsg) throw new Error("Mensagem alvo não encontrada.");

        const key = {
            remoteJid: normalizeJid(remoteJid),
            id: targetMsg.whatsapp_id,
            fromMe: targetMsg.from_me
        };

        await session.sock.sendMessage(normalizeJid(remoteJid), { react: { text: reaction, key: key } });
        return { success: true };
    } catch (error) {
        console.error(`[Controller] Erro ao reagir:`, error);
        throw error;
    }
};

export const deleteMessage = async (sessionId, companyId, remoteJid, msgId, everyone = false) => {
    try {
        await supabase.from('messages').update({ is_deleted: true, content: '🚫 Mensagem apagada' }).eq('id', msgId).eq('company_id', companyId);

        if (everyone) {
            const session = sessions.get(sessionId);
            if (session?.sock) {
                const { data: targetMsg } = await supabase.from('messages').select('whatsapp_id, from_me').eq('id', msgId).single();
                if (targetMsg) {
                    const key = { remoteJid: normalizeJid(remoteJid), id: targetMsg.whatsapp_id, fromMe: targetMsg.from_me };
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
        const { data } = await supabase.from('instances').select('session_id').eq('company_id', companyId).eq('status', 'connected').limit(1).maybeSingle();
        if (data) return data.session_id;
        
        const { data: anySession } = await supabase.from('instances').select('session_id').eq('company_id', companyId).limit(1).maybeSingle();
        return anySession?.session_id || null;
    } catch (error) {
        return null;
    }
};
