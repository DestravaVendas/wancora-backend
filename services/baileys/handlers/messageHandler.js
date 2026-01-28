
import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    normalizeJid
} from '../../crm/sync.js';
import { getContentType } from '@whiskeysockets/baileys';
import { handleMediaUpload } from './mediaHandler.js';
import { unwrapMessage, getBody } from '../../../utils/wppParsers.js';
import { dispatchWebhook } from '../../integrations/webhook.js'; // Import Webhook
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const msgCache = new Set();
const addToCache = (id) => {
    if (msgCache.has(id)) return false;
    msgCache.add(id);
    setTimeout(() => msgCache.delete(id), 10000); 
    return true;
};

// Cache simples em memória para evitar query no banco a cada mensagem para checar webhook
const instanceConfigCache = new Map();

// Atualiza cache a cada 1 min
const getInstanceConfig = async (sessionId, companyId) => {
    if (instanceConfigCache.has(sessionId)) return instanceConfigCache.get(sessionId);
    
    const { data } = await supabase.from('instances')
        .select('webhook_url, webhook_enabled')
        .eq('session_id', sessionId)
        .eq('company_id', companyId)
        .single();
    
    const config = data || { webhook_enabled: false };
    instanceConfigCache.set(sessionId, config);
    
    // Expira em 60s
    setTimeout(() => instanceConfigCache.delete(sessionId), 60000);
    return config;
};

export const handleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null, options = {}) => {
    try {
        // 1. Filtros Iniciais
        if (!msg.message) return;
        if (isRealtime && !addToCache(msg.key.id)) return;

        const protocolMsg = msg.message?.protocolMessage;

        // 2. Tratamento de REVOKE (Apagar Mensagem)
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

        // 2.1 Tratamento de EDIT (Editar Mensagem) - Type 14
        if (protocolMsg && protocolMsg.type === 14) {
            const keyToEdit = protocolMsg.key;
            if (keyToEdit && keyToEdit.id && protocolMsg.editedMessage) {
                const newContent = getBody(protocolMsg.editedMessage);
                if (newContent) {
                    console.log(`✏️ [MSG HANDLER] Mensagem editada: ${keyToEdit.id}`);
                    await supabase.from('messages')
                        .update({ content: newContent, updated_at: new Date() })
                        .eq('whatsapp_id', keyToEdit.id)
                        .eq('company_id', companyId);
                }
            }
            return;
        }

        // 3. Preparação dos Dados
        const cleanMsg = unwrapMessage(msg);
        const jid = normalizeJid(cleanMsg.key.remoteJid);
        if (jid === 'status@broadcast') return;

        const body = getBody(cleanMsg.message);
        const type = getContentType(cleanMsg.message) || Object.keys(cleanMsg.message)[0];
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);

        if (!body && !isMedia && !type?.includes('poll')) return;

        const fromMe = cleanMsg.key.fromMe;
        const myJid = normalizeJid(sock.user?.id);

        // 4. Name Hunter & Lead Creation
        let leadId = null;
        
        if (!fromMe && jid && !jid.includes('@g.us')) {
            const finalName = forcedName || cleanMsg.pushName;

            // Busca foto apenas se necessário
            if (isRealtime || options.fetchProfilePic) {
                sock.profilePictureUrl(jid, 'image')
                    .then(url => {
                        if (url) upsertContact(jid, companyId, finalName, url, false);
                    })
                    .catch(() => {});
            }
            
            leadId = await ensureLeadExists(jid, companyId, finalName, myJid);
        }
        
        // Upsert de Contato em Grupo
        if (jid.includes('@g.us') && cleanMsg.key.participant) {
             const partJid = normalizeJid(cleanMsg.key.participant);
             if (partJid !== myJid && (forcedName || cleanMsg.pushName)) {
                 await upsertContact(partJid, companyId, forcedName || cleanMsg.pushName, null, false);
             }
        }

        // 5. Media Handling
        let mediaUrl = null;
        if (isMedia && (isRealtime || options.downloadMedia)) {
            mediaUrl = await handleMediaUpload(cleanMsg);
        }

        let messageTypeClean = type?.replace('Message', '') || 'text';
        if (type === 'audioMessage' && cleanMsg.message.audioMessage.ptt) messageTypeClean = 'ptt'; 
        if (type?.includes('poll')) messageTypeClean = 'poll';

        // 7. Conteúdo Final
        let finalContent = body || (mediaUrl ? '[Mídia]' : '');
        
        if (messageTypeClean === 'poll') {
            const pollMsg = cleanMsg.message?.pollCreationMessageV3 || cleanMsg.message?.pollCreationMessage;
            if (pollMsg) {
                finalContent = JSON.stringify({
                    name: pollMsg.name,
                    options: pollMsg.options.map(o => o.optionName),
                    selectableOptionsCount: pollMsg.selectableOptionsCount
                });
            }
        }

        // 8. Persistência (Trigger SQL cuidará dos stats em 'contacts')
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

        // 9. Webhook
        if (isRealtime && !fromMe) {
            const config = await getInstanceConfig(sessionId, companyId);
            if (config.webhook_enabled && config.webhook_url) {
                dispatchWebhook(config.webhook_url, 'message.upsert', {
                    ...savedMsg,
                    pushName: cleanMsg.pushName,
                    isGroup: jid.includes('@g.us')
                });
            }
        }

    } catch (e) {
        console.error("❌ [MSG HANDLER] Erro:", e);
    }
};

export const handleReceiptUpdate = async (events, companyId) => {
    // Mantido pois o Baileys emite eventos de leitura separadamente
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
        
        // Se foi lido, zera o contador no contato
        if (dbStatus === 'read') {
             await supabase.from('contacts').update({ unread_count: 0 }).eq('jid', normalizeJid(event.key.remoteJid)).eq('company_id', companyId);
        }
    }
};

export const handleMessageUpdate = async (updates, companyId) => {
    // Lógica de Polls mantida (Votos chegam aqui)
    for (const update of updates) {
        if (update.pollUpdates) {
            const pollCreationKey = update.key;
            if (!pollCreationKey) continue;

            for (const pollUpdate of update.pollUpdates) {
                const vote = pollUpdate.vote;
                if (!vote) continue;
                
                const voterJid = normalizeJid(pollUpdate.pollUpdateMessageKey?.participant || pollUpdate.pollUpdateMessageKey?.remoteJid);
                const selectedOptions = vote.selectedOptions || [];
                
                const { data: originalMsg } = await supabase
                    .from('messages')
                    .select('content, poll_votes')
                    .eq('whatsapp_id', pollCreationKey.id)
                    .eq('company_id', companyId)
                    .single();

                if (originalMsg) {
                    let pollData = {};
                    try { pollData = typeof originalMsg.content === 'string' ? JSON.parse(originalMsg.content) : originalMsg.content; } catch(e){}
                    
                    let currentVotes = Array.isArray(originalMsg.poll_votes) ? originalMsg.poll_votes : [];
                    currentVotes = currentVotes.filter(v => v.voterJid !== voterJid);

                    if (selectedOptions.length > 0) {
                            selectedOptions.forEach(opt => {
                                const optName = opt.name || 'Desconhecido';
                                const idx = pollData.options?.findIndex(o => o === optName);
                                currentVotes.push({
                                    voterJid,
                                    optionId: idx !== -1 ? idx : 0,
                                    ts: Date.now(),
                                    selectedOptions: [optName] 
                                });
                            });
                    }

                    await supabase.from('messages').update({ poll_votes: currentVotes }).eq('whatsapp_id', pollCreationKey.id).eq('company_id', companyId);
                }
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
