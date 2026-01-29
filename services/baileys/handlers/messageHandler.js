
import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    normalizeJid
} from '../../crm/sync.js';
import { getContentType, getAggregateVotesInPollMessage } from '@whiskeysockets/baileys';
import { handleMediaUpload } from './mediaHandler.js';
import { refreshContactInfo } from './contactHandler.js'; // NOVO IMPORT
import { unwrapMessage, getBody } from '../../../utils/wppParsers.js';
import { dispatchWebhook } from '../../integrations/webhook.js'; 
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const msgCache = new Set();
const addToCache = (id) => {
    if (msgCache.has(id)) return false;
    msgCache.add(id);
    setTimeout(() => msgCache.delete(id), 10000); 
    return true;
};

const instanceConfigCache = new Map();

const getInstanceConfig = async (sessionId, companyId) => {
    if (instanceConfigCache.has(sessionId)) return instanceConfigCache.get(sessionId);
    
    const { data } = await supabase.from('instances')
        .select('webhook_url, webhook_enabled, id')
        .eq('session_id', sessionId)
        .eq('company_id', companyId)
        .single();
    
    const config = data || { webhook_enabled: false };
    instanceConfigCache.set(sessionId, config);
    setTimeout(() => instanceConfigCache.delete(sessionId), 60000);
    return config;
};

export const handleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null, options = {}) => {
    try {
        if (!msg.message) return;
        if (isRealtime && !addToCache(msg.key.id)) return;

        const protocolMsg = msg.message?.protocolMessage;

        // Revoke Handler (Mensagem Apagada)
        if (protocolMsg && protocolMsg.type === 0) {
            const keyToRevoke = protocolMsg.key;
            if (keyToRevoke && keyToRevoke.id) {
                await supabase.from('messages')
                    .update({ content: '⊘ Mensagem apagada', message_type: 'text', is_deleted: true })
                    .eq('whatsapp_id', keyToRevoke.id)
                    .eq('company_id', companyId);
            }
            return; 
        }

        // Edit Handler (Mensagem Editada)
        if (protocolMsg && protocolMsg.type === 14) {
            const keyToEdit = protocolMsg.key;
            if (keyToEdit && keyToEdit.id && protocolMsg.editedMessage) {
                const newContent = getBody(protocolMsg.editedMessage);
                if (newContent) {
                    await supabase.from('messages')
                        .update({ content: newContent, updated_at: new Date() })
                        .eq('whatsapp_id', keyToEdit.id)
                        .eq('company_id', companyId);
                }
            }
            return;
        }

        const cleanMsg = unwrapMessage(msg);
        const jid = normalizeJid(cleanMsg.key.remoteJid);
        if (jid === 'status@broadcast') return;

        const body = getBody(cleanMsg.message);
        const type = getContentType(cleanMsg.message) || Object.keys(cleanMsg.message)[0];
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);

        if (!body && !isMedia && !type?.includes('poll')) return;

        const fromMe = cleanMsg.key.fromMe;
        const myJid = normalizeJid(sock.user?.id);
        const isGroup = jid.includes('@g.us');

        let leadId = null;
        const finalName = forcedName || cleanMsg.pushName;
        
        // 1. TRATAMENTO DE INDIVIDUAIS (LEADS)
        if (!fromMe && !isGroup) {
            // SMART FETCH: Substitui lógica aleatória anterior
            // Verifica no banco se precisa atualizar a foto (Cache 24h)
            if (isRealtime) {
                await refreshContactInfo(sock, jid, companyId, finalName);
            } else if (finalName) {
                // Histórico: Apenas atualiza nome, sem foto (para performance)
                upsertContact(jid, companyId, finalName, null, false);
            }
            
            leadId = await ensureLeadExists(jid, companyId, finalName, myJid);
        }
        
        // 2. TRATAMENTO DE GRUPOS (COMUNIDADE)
        if (isGroup) {
             if (cleanMsg.key.participant) {
                 const partJid = normalizeJid(cleanMsg.key.participant);
                 if (partJid !== myJid && finalName) {
                     // Smart Fetch para participantes também
                     if (isRealtime) await refreshContactInfo(sock, partJid, companyId, finalName);
                     else await upsertContact(partJid, companyId, finalName, null, false);
                 }
             }

             // Foto do Grupo (Lazy Load tbm)
             if (isRealtime) {
                 await refreshContactInfo(sock, jid, companyId, null);
             }
        }

        let mediaUrl = null;
        if (isMedia && (isRealtime || options.downloadMedia)) {
            mediaUrl = await handleMediaUpload(cleanMsg, companyId);
        }

        let messageTypeClean = type?.replace('Message', '') || 'text';
        if (type === 'audioMessage' && cleanMsg.message.audioMessage.ptt) messageTypeClean = 'ptt'; 
        
        // Tratamento de Enquete (Poll Creation)
        let finalContent = body || (mediaUrl ? '[Mídia]' : '');

        if (type === 'pollCreationMessage' || type === 'pollCreationMessageV3') {
            messageTypeClean = 'poll';
            const pollData = cleanMsg.message[type];
            if (pollData) {
                finalContent = JSON.stringify({
                    name: pollData.name,
                    options: pollData.options.map(o => o.optionName),
                    selectableOptionsCount: pollData.selectableOptionsCount
                });
            }
        }

        const savedMsg = {
            company_id: companyId,
            session_id: sessionId,
            remote_jid: jid,
            whatsapp_id: cleanMsg.key.id,
            from_me: fromMe,
            content: finalContent,
            media_url: mediaUrl,
            message_type: messageTypeClean,
            status: fromMe ? 'sent' : 'received',
            lead_id: leadId,
            created_at: new Date((cleanMsg.messageTimestamp || Date.now() / 1000) * 1000)
        };

        await upsertMessage(savedMsg);

        if (isRealtime && !fromMe) {
            const config = await getInstanceConfig(sessionId, companyId);
            if (config.webhook_enabled && config.webhook_url) {
                dispatchWebhook(config.webhook_url, 'message.upsert', {
                    company_id: companyId,
                    session_id: sessionId,
                    remote_jid: jid,
                    pushName: cleanMsg.pushName,
                    content: finalContent,
                    message_type: messageTypeClean,
                    from_me: fromMe,
                    isGroup: isGroup,
                    media_url: mediaUrl,
                    whatsapp_id: cleanMsg.key.id
                }, config.id);
            }
        }

    } catch (e) {
        console.error("❌ [MSG HANDLER] Erro:", e);
    }
};

export const handleReceiptUpdate = async (events, companyId) => {
    for (const event of events) {
        const receiptStatus = event.receipt.status;
        let dbStatus = null;
        if (receiptStatus === 3) dbStatus = 'delivered';
        else if (receiptStatus === 4 || receiptStatus === 5) dbStatus = 'read';
        
        if (!dbStatus) continue;

        const updates = { status: dbStatus };
        if (dbStatus === 'delivered') updates.delivered_at = new Date();
        if (dbStatus === 'read') updates.read_at = new Date();

        await supabase.from('messages').update(updates).eq('whatsapp_id', event.key.id).eq('company_id', companyId);
        
        if (dbStatus === 'read') {
             await supabase.from('contacts').update({ unread_count: 0 }).eq('jid', normalizeJid(event.key.remoteJid)).eq('company_id', companyId);
        }
    }
};

// --- Handler de Atualizações de Enquete (Votos) ---
export const handleMessageUpdate = async (updates, companyId) => {
    for (const update of updates) {
        if (update.pollUpdates) {
            const pollCreationKey = update.key;
            if (!pollCreationKey) continue;

            try {
                const { data: originalMsg } = await supabase
                    .from('messages')
                    .select('content, poll_votes')
                    .eq('whatsapp_id', pollCreationKey.id)
                    .eq('company_id', companyId)
                    .single();

                if (originalMsg) {
                    const pollContent = typeof originalMsg.content === 'string' ? JSON.parse(originalMsg.content) : originalMsg.content;
                    
                    const creationMessage = {
                        pollCreationMessage: {
                            name: pollContent.name,
                            options: pollContent.options.map(opt => ({ optionName: opt })),
                            selectableOptionsCount: pollContent.selectableOptionsCount
                        }
                    };

                    const aggregation = getAggregateVotesInPollMessage({
                        message: creationMessage,
                        pollUpdates: update.pollUpdates
                    });

                    const voteMap = new Map();

                    for (const option of aggregation) {
                        for (const voter of option.voters) {
                            const cleanVoter = normalizeJid(voter);
                            if (!voteMap.has(cleanVoter)) voteMap.set(cleanVoter, []);
                            voteMap.get(cleanVoter).push(option.name);
                        }
                    }

                    const newPollVotes = [];
                    voteMap.forEach((selectedOptions, voterJid) => {
                        newPollVotes.push({
                            voterJid,
                            selectedOptions,
                            ts: Date.now()
                        });
                    });

                    console.log(`🗳️ [POLL] Votos computados para msg ${pollCreationKey.id}`);
                    await supabase.from('messages')
                        .update({ poll_votes: newPollVotes })
                        .eq('whatsapp_id', pollCreationKey.id)
                        .eq('company_id', companyId);
                }
            } catch (err) {
                console.error("❌ [POLL] Erro ao processar voto:", err);
            }
        }
    }
};

export const handleReaction = async (reactions, sock, companyId) => {
    for (const reaction of reactions) {
        const { key, text } = reaction;
        if (!key.id) continue;

        const myJid = normalizeJid(sock.user?.id);
        const reactorJid = normalizeJid(reaction.key.participant || reaction.key.remoteJid || myJid);

        const { data: msg } = await supabase.from('messages').select('reactions').eq('whatsapp_id', key.id).eq('company_id', companyId).single();

        if (msg) {
            let currentReactions = Array.isArray(msg.reactions) ? msg.reactions : [];
            currentReactions = currentReactions.filter(r => r.actor !== reactorJid);
            if (text) currentReactions.push({ text, actor: reactorJid, ts: Date.now() });
            
            await supabase.from('messages').update({ reactions: currentReactions }).eq('whatsapp_id', key.id).eq('company_id', companyId);
        }
    }
};
