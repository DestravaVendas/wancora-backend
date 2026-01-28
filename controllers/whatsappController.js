
import { createClient } from "@supabase/supabase-js";
import { startSession as startService, deleteSession as deleteService, sessions } from '../services/baileys/connection.js';
import { sendMessage as sendService } from '../services/baileys/sender.js';
import { 
    createGroup as createGroupService, 
    manageGroupParticipants as manageParticipantsService,
    updateGroupSettings as updateGroupService,
    updateGroupPicture as updatePictureService,
    getGroupInviteCode as getInviteService,
    createChannel as createChannelService,
    deleteChannel as deleteChannelService
} from '../services/baileys/community.js';
import { normalizeJid } from '../utils/wppParsers.js';
import { proto } from '@whiskeysockets/baileys';

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
        return await deleteService(sessionId, companyId);
    } catch (error) {
        console.error(`[Controller] Erro ao deletar sessão:`, error);
        throw error;
    }
};

export const sendMessage = async (payload) => {
    try {
        return await sendService(payload);
    } catch (error) {
        console.error(`[Controller] Erro ao enviar mensagem:`, error);
        throw error; 
    }
};

// --- GRUPOS & CANAIS (Community) ---

export const createGroup = async (req, res) => {
    const { sessionId, companyId, subject, participants } = req.body;
    try {
        const group = await createGroupService(sessionId, companyId, subject, participants);
        res.json({ success: true, group });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const updateGroup = async (req, res) => {
    const { sessionId, groupId, action, value, participants } = req.body;
    try {
        let result;
        if (['add', 'remove', 'promote', 'demote'].includes(action)) {
            result = await manageParticipantsService(sessionId, groupId, action, participants);
        } else if (action === 'invite_code') {
            result = { code: await getInviteService(sessionId, groupId) };
        } else if (action === 'picture') {
            // value aqui deve ser a URL da imagem
            result = await updatePictureService(sessionId, groupId, value);
        } else {
            result = await updateGroupService(sessionId, groupId, action, value);
        }
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const createChannel = async (req, res) => {
    const { sessionId, companyId, name, description } = req.body;
    try {
        const channel = await createChannelService(sessionId, companyId, name, description);
        res.json({ success: true, channel });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const deleteChannel = async (req, res) => {
    const { sessionId, channelId } = req.body;
    try {
        await deleteChannelService(sessionId, channelId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// --- FIM Community ---

export const sendPollVote = async (sessionId, companyId, remoteJid, pollId, optionId) => {
    try {
        const session = sessions.get(sessionId);
        if (!session || !session.sock) throw new Error("Sessão desconectada.");

        // 1. Busca dados da enquete original
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

        // 2. Resolve a opção com Robustez
        let optionsList = [];
        if (Array.isArray(pollContent.options)) {
            optionsList = pollContent.options.map(opt => (typeof opt === 'object' && opt.optionName) ? opt.optionName : opt);
        } else if (pollContent.values) {
            // Suporte legado
            optionsList = pollContent.values;
        } else {
            throw new Error("Estrutura da enquete inválida.");
        }

        const selectedOptionText = optionsList[optionId];
        
        if (selectedOptionText === undefined) {
            throw new Error(`Opção inválida: Index ${optionId} não existe em [${optionsList.join(', ')}].`);
        }

        const cleanOptionText = selectedOptionText; 
        
        if (!cleanOptionText) {
            throw new Error("Opção de voto vazia ou inválida.");
        }

        console.log(`🗳️ [VOTE] Votando em: "${cleanOptionText}" (Index: ${optionId})`);

        const chatJid = normalizeJid(remoteJid);
        
        // 3. Payload de Voto
        await session.sock.sendMessage(chatJid, {
            poll: {
                vote: {
                    key: {
                        remoteJid: chatJid,
                        id: pollMsg.whatsapp_id,
                        fromMe: pollMsg.from_me,
                    },
                    selectedOptions: [cleanOptionText] 
                }
            }
        });

        // 4. Salva no banco (Update Local)
        const myJid = normalizeJid(session.sock.user?.id);
        
        const { data: currentMsg } = await supabase.from('messages').select('poll_votes').eq('whatsapp_id', pollMsg.whatsapp_id).single();
        let votes = currentMsg?.poll_votes || [];
        
        // Remove voto anterior meu se for single choice
        votes = votes.filter(v => v.voterJid !== myJid);

        votes.push({
            voterJid: myJid,
            ts: Date.now(),
            selectedOptions: [cleanOptionText]
        });

        await supabase.from('messages')
            .update({ poll_votes: votes })
            .eq('whatsapp_id', pollMsg.whatsapp_id)
            .eq('company_id', companyId);

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
        await supabase.from('messages')
            .update({ is_deleted: true, content: '⊘ Mensagem apagada' }) 
            .eq('id', msgId)
            .eq('company_id', companyId);

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
    } catch (error) { return null; }
};
