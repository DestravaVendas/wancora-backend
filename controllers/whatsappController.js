import { createClient } from "@supabase/supabase-js";
import { startSession as startService, deleteSession as deleteService, sessions } from '../services/baileys/connection.js';
import { sendMessage as sendService, executeLocked } from '../services/baileys/sender.js';
import { 
    createGroup as createGroupService, 
    manageGroupParticipants as manageParticipantsService,
    updateGroupSettings as updateGroupService,
    updateGroupPicture as updatePictureService,
    getGroupInviteCode as getInviteService,
    createCommunity as createCommunityService
} from '../services/baileys/community.js';
import { fetchCatalog } from '../services/baileys/catalog.js';
import { normalizeJid } from '../utils/wppParsers.js';
import { proto } from '@whiskeysockets/baileys';
import { runCampaignStress, runAIStress } from '../utils/stressTest.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// --- SESSÃO & MENSAGEM ---
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

export const sendMessage = async (payload) => sendService(payload);

// --- COMUNIDADES & GRUPOS ---

export const createGroup = async (req, res) => {
    const { sessionId, companyId, subject, participants } = req.body;
    try {
        const group = await createGroupService(sessionId, companyId, subject, participants);
        res.json({ success: true, group });
    } catch (error) { res.status(500).json({ error: error.message }); }
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
            result = await updatePictureService(sessionId, groupId, value);
        } else {
            result = await updateGroupService(sessionId, groupId, action, value);
        }
        res.json({ success: true, result });
    } catch (error) { res.status(500).json({ error: error.message }); }
};

// [NOVO] Endpoint para buscar metadados do grupo (Participantes)
export const getGroupMetadata = async (req, res) => {
    const { sessionId, groupId } = req.body;
    
    try {
        const session = sessions.get(sessionId);
        if (!session || !session.sock) throw new Error("Sessão desconectada.");

        const jid = normalizeJid(groupId);
        const metadata = await session.sock.groupMetadata(jid);

        res.json({ success: true, metadata });
    } catch (error) {
        console.error("Erro getGroupMetadata:", error);
        res.status(500).json({ error: error.message });
    }
};

export const createCommunity = async (req, res) => {
    const { sessionId, companyId, subject, description } = req.body;
    try {
        const community = await createCommunityService(sessionId, companyId, subject, description);
        res.json({ success: true, community });
    } catch (error) { res.status(500).json({ error: error.message }); }
};

// --- CATÁLOGO ---
export const syncCatalog = async (req, res) => {
    const { sessionId, companyId } = req.body;
    try {
        const result = await fetchCatalog(sessionId, companyId);
        res.json({ success: true, result });
    } catch (error) { res.status(500).json({ error: error.message }); }
};

// --- INTERATIVIDADE (VOTE/REACT/DELETE) ---
export const sendPollVote = async (sessionId, companyId, remoteJid, pollId, optionId) => {
    try {
        const session = sessions.get(sessionId);
        if (!session || !session.sock) throw new Error("Sessão desconectada.");

        const { data: pollMsg } = await supabase.from('messages').select('whatsapp_id, from_me, content').eq('id', pollId).single();
        if (!pollMsg) throw new Error("Enquete não encontrada no banco.");

        // --- DIAGNÓSTICO DE ENQUETE (RAIO-X) ---
        console.log(`🔍 [POLL DEBUG] Processando voto. MsgID: ${pollMsg.whatsapp_id}`);

        let pollContent;
        try {
            // Tenta parsear caso esteja salvo como string
            if (typeof pollMsg.content === 'string') {
                const cleanJson = pollMsg.content.trim();
                pollContent = JSON.parse(cleanJson);
            } else {
                pollContent = pollMsg.content;
            }
        } catch (e) { 
            console.error("Erro parse poll content:", pollMsg.content);
            throw new Error("Conteúdo da enquete corrompido ou formato inválido."); 
        }

        console.log(`🔍 [POLL DEBUG] Estrutura extraída:`, JSON.stringify(pollContent));

        // Lógica Robusta de Extração de Opções
        let optionsList = [];
        
        if (pollContent.pollCreationMessageV3) {
            optionsList = pollContent.pollCreationMessageV3.options.map(o => o.optionName || o);
        } else if (pollContent.pollCreationMessage) {
            optionsList = pollContent.pollCreationMessage.options.map(o => o.optionName || o);
        } else if (Array.isArray(pollContent.options)) {
             // Tratamento híbrido: pode ser array de strings ou objetos
             optionsList = pollContent.options.map(opt => (typeof opt === 'object' && opt.optionName) ? opt.optionName : opt);
        } else if (pollContent.values) {
            optionsList = pollContent.values;
        }

        console.log(`🔍 [POLL DEBUG] Lista de Opções Final:`, optionsList);

        const selectedOptionText = optionsList[optionId];
        
        if (!selectedOptionText) {
            console.error("❌ [POLL ERROR] Index solicitado:", optionId, "não existe em", optionsList);
            throw new Error(`Opção inválida: Index ${optionId} não existe na enquete.`);
        }

        console.log(`🗳️ [POLL DEBUG] Votando em: "${selectedOptionText}"`);

        const chatJid = normalizeJid(remoteJid);
        
        // CONSTRUÇÃO ESTRITA DA CHAVE (Tipagem é crucial para o Baileys)
        const voteKey = {
            remoteJid: chatJid,
            id: pollMsg.whatsapp_id,
            fromMe: Boolean(pollMsg.from_me) // Força booleano
        };

        // ENVIO DO VOTO (Payload Limpo)
        // O Baileys precisa que a opção selecionada seja IDÊNTICA (case-sensitive, space-sensitive)
        await executeLocked(sessionId, async () => {
            await session.sock.sendMessage(chatJid, {
                poll: {
                    vote: {
                        key: voteKey,
                        selectedOptions: [selectedOptionText] 
                    }
                }
            });
        });

        console.log(`✅ [POLL DEBUG] Voto enviado ao socket.`);

        // Atualização Otimista no Banco (Para feedback imediato)
        const myJid = normalizeJid(session.sock.user?.id);
        
        const { data: currentMsg } = await supabase.from('messages').select('poll_votes').eq('whatsapp_id', pollMsg.whatsapp_id).single();
        let votes = currentMsg?.poll_votes || [];
        
        // Remove voto anterior do mesmo usuário (se houver) e adiciona o novo
        votes = votes.filter(v => v.voterJid !== myJid);
        votes.push({ voterJid: myJid, ts: Date.now(), selectedOptions: [selectedOptionText] });

        await supabase.from('messages').update({ poll_votes: votes }).eq('whatsapp_id', pollMsg.whatsapp_id).eq('company_id', companyId);

        return { success: true };
    } catch (error) {
        console.error(`❌ [Controller] Erro ao votar:`, error.message);
        throw error;
    }
};

export const sendReaction = async (sessionId, companyId, remoteJid, msgId, reaction) => {
    try {
        const session = sessions.get(sessionId);
        if (!session?.sock) throw new Error("Sessão desconectada.");

        const { data: targetMsg } = await supabase.from('messages').select('whatsapp_id, from_me').eq('id', msgId).single();
        if (!targetMsg) throw new Error("Mensagem alvo não encontrada.");

        // Se reaction for vazia, envia string vazia para remover
        const text = reaction || "";

        const key = { remoteJid: normalizeJid(remoteJid), id: targetMsg.whatsapp_id, fromMe: targetMsg.from_me };
        await executeLocked(sessionId, async () => {
            await session.sock.sendMessage(normalizeJid(remoteJid), { react: { text: text, key: key } });
        });
        return { success: true };
    } catch (error) {
        console.error(`[Controller] Erro ao reagir:`, error);
        throw error;
    }
};

export const deleteMessage = async (sessionId, companyId, remoteJid, msgId, everyone = false) => {
    try {
        await supabase.from('messages').update({ is_deleted: true, content: '⊘ Mensagem apagada' }).eq('id', msgId).eq('company_id', companyId);
        if (everyone) {
            const session = sessions.get(sessionId);
            if (session?.sock) {
                const { data: targetMsg } = await supabase.from('messages').select('whatsapp_id, from_me').eq('id', msgId).single();
                if (targetMsg) {
                    const key = { remoteJid: normalizeJid(remoteJid), id: targetMsg.whatsapp_id, fromMe: targetMsg.from_me };
                    await executeLocked(sessionId, async () => {
                        await session.sock.sendMessage(normalizeJid(remoteJid), { delete: key });
                    });
                }
            }
        }
        return { success: true };
    } catch (error) {
        console.error(`[Controller] Erro ao deletar:`, error);
        throw error;
    }
};

export const markChatAsRead = async (sessionId, companyId, remoteJid) => {
    try {
        const session = sessions.get(sessionId);
        if (!session?.sock) return; 
        const jid = normalizeJid(remoteJid);
        
        // Tenta se inscrever na presença para garantir status online
        await session.sock.presenceSubscribe(jid);
        
        // Marca como lido as não lidas
        const { data: unreadMsgs } = await supabase.from('messages')
            .select('whatsapp_id, from_me')
            .eq('company_id', companyId)
            .eq('remote_jid', jid)
            .eq('from_me', false)
            .neq('status', 'read')
            .limit(20); 
            
        if (unreadMsgs && unreadMsgs.length > 0) {
            const keys = unreadMsgs.map(m => ({ remoteJid: jid, id: m.whatsapp_id, fromMe: false }));
            await session.sock.readMessages(keys);
            
            // Atualiza banco
            await supabase.from('messages')
                .update({ status: 'read', read_at: new Date() })
                .eq('company_id', companyId)
                .eq('remote_jid', jid)
                .in('whatsapp_id', unreadMsgs.map(m => m.whatsapp_id));
            
            await supabase.from('contacts')
                .update({ unread_count: 0 })
                .eq('company_id', companyId)
                .eq('jid', jid);
        }
        return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
};

export const getSessionId = async (companyId) => {
    try {
        const { data } = await supabase.from('instances').select('session_id').eq('company_id', companyId).eq('status', 'connected').limit(1).maybeSingle();
        if (data) return data.session_id;
        const { data: anySession } = await supabase.from('instances').select('session_id').eq('company_id', companyId).limit(1).maybeSingle();
        return anySession?.session_id || null;
    } catch (error) { return null; }
};

export const subscribeToPresence = async (sessionId, remoteJid) => {
    try {
        const session = sessions.get(sessionId);
        if (!session?.sock) return { success: false, error: "Sessão desconectada." };
        
        const jid = normalizeJid(remoteJid);
        await session.sock.presenceSubscribe(jid);
        
        return { success: true };
    } catch (error) {
        console.error(`[Controller] Erro ao assinar presença para ${remoteJid}:`, error.message);
        return { success: false, error: error.message };
    }
};

// --- TESTES DE STRESS E IA ---
export const triggerStressTest = async (req, res) => {
    const { companyId, count } = req.body;
    try {
        const result = await runCampaignStress(companyId, count);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const triggerAITest = async (req, res) => {
    const { companyId, leadId, iterations } = req.body;
    try {
        const result = await runAIStress(companyId, leadId, iterations);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// 🛡️ [FEATURE] Atualiza/Baixa a foto de perfil de um contato sob demanda.
// Trata erros de timeout e privacidade de forma graciosa.
export const refreshContactPic = async (req, res) => {
    const { jid, sessionId, companyId } = req.body;
    
    if (!jid || !sessionId || !companyId) {
        return res.status(400).json({ error: "JID, SessionID e CompanyID são obrigatórios" });
    }

    const session = sessions.get(sessionId);
    if (!session || !session.sock) {
        return res.status(404).json({ error: "Sessão do WhatsApp não encontrada ou desconectada na memória." });
    }

    try {
        let targetJid = jid;
        if (targetJid.includes('@lid')) {
            const { data: mapData } = await supabase.from('identity_map')
                .select('phone_jid')
                .eq('lid_jid', targetJid)
                .eq('company_id', companyId)
                .maybeSingle();
            
            if (mapData?.phone_jid) {
                targetJid = mapData.phone_jid;
            }
        }

        // 🛡️ TIMEOUT RACE: O WhatsApp pode demorar a responder se o alvo estiver offline.
        // Forçamos o cancelamento em 10 segundos para não prender a UI do cliente.
        const fetchPicPromise = session.sock.profilePictureUrl(targetJid, 'image');
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('TIMEOUT_BAILEYS')), 10000)
        );

        const ppUrl = await Promise.race([fetchPicPromise, timeoutPromise]);

        if (ppUrl) {
            // Salva a nova URL no Supabase (Atualizando o timestamp)
            await supabase.from('contacts')
                .update({ profile_pic_url: ppUrl, profile_pic_updated_at: new Date() })
                .eq('jid', jid)
                .eq('company_id', companyId);

            return res.json({ profilePicUrl: ppUrl });
        }

        return res.json({ profilePicUrl: null, status: 'no_picture' });

    } catch (error) {
        const msg = error.message || '';
        
        // Trata erro de "Privacidade" (Foto visível só para contatos)
        if (msg.includes('not-authorized') || msg.includes('item-not-found') || msg.includes('401')) {
            return res.json({ profilePicUrl: null, status: 'private_or_empty' });
        }
        
        // Trata a demora da Meta
        if (msg.includes('TIMEOUT_BAILEYS')) {
            return res.json({ profilePicUrl: null, status: 'timeout' });
        }

        console.error(`❌ [REFRESH PIC] Erro interno para ${jid}:`, msg);
        return res.status(500).json({ error: "Erro ao comunicar com o WhatsApp" });
    }
};
