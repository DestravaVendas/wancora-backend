
import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    normalizeJid
} from '../../crm/sync.js';
import { getContentType } from '@whiskeysockets/baileys';
import { handleMediaUpload } from './mediaHandler.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Cache de curto prazo para deduplicação em memória (além do banco)
const msgCache = new Set();
const addToCache = (id) => {
    if (msgCache.has(id)) return false;
    msgCache.add(id);
    setTimeout(() => msgCache.delete(id), 10000); 
    return true;
};

// Utilitário para extrair conteúdo real da mensagem
export const unwrapMessage = (msg) => {
    if (!msg.message) return msg;
    let content = msg.message;
    
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    if (content.viewOnceMessage) content = content.viewOnceMessage.message;
    if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
    if (content.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;
    
    if (content.editedMessage) {
        content = content.editedMessage.message?.protocolMessage?.editedMessage || content.editedMessage.message;
    }
    
    return { ...msg, message: content };
};

const getBody = (msg) => {
    if (!msg) return '';
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.pollCreationMessageV3) return msg.pollCreationMessageV3.name;
    if (msg.pollCreationMessage) return msg.pollCreationMessage.name;
    return ''; 
};

/**
 * Processa uma única mensagem (Realtime ou Histórico)
 */
export const handleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null) => {
    try {
        // 1. Filtros Iniciais
        if (!msg.message) return;
        if (isRealtime && !addToCache(msg.key.id)) return; // Deduplicação

        // 2. Tratamento de REVOKE (Apagar Mensagem)
        const protocolMsg = msg.message?.protocolMessage;
        if (protocolMsg && protocolMsg.type === 0) {
            const keyToRevoke = protocolMsg.key;
            if (keyToRevoke && keyToRevoke.id) {
                console.log(`🗑️ [REVOKE] Mensagem apagada: ${keyToRevoke.id}`);
                await supabase.from('messages')
                    .update({ 
                        content: '⊘ Mensagem apagada', 
                        message_type: 'text', 
                        is_deleted: true 
                    })
                    .eq('whatsapp_id', keyToRevoke.id)
                    .eq('company_id', companyId);
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

        if (!body && !isMedia && type !== 'pollCreationMessageV3' && type !== 'pollCreationMessage') return;

        const fromMe = cleanMsg.key.fromMe;
        const myJid = normalizeJid(sock.user?.id);

        // 4. Name Hunter & Lead Creation (CRM)
        // Se não sou eu, tento identificar ou criar o contato/lead
        let leadId = null;
        if (!fromMe && jid && !jid.includes('@g.us')) {
            // Tenta obter foto de perfil (apenas em realtime para não travar histórico)
            if (isRealtime) {
                try {
                    // Fetch Profile Pic async (não bloqueante)
                    sock.profilePictureUrl(jid, 'image').then(url => {
                        if(url) upsertContact(jid, companyId, cleanMsg.pushName, url, false);
                    }).catch(() => {});
                } catch(e) {}
            }
            
            // Garante existência do Lead (Lógica robusta do sync.js)
            leadId = await ensureLeadExists(jid, companyId, forcedName || cleanMsg.pushName, myJid);
        }
        
        // Em grupos, garante que o participante existe como contato
        if (jid.includes('@g.us') && cleanMsg.key.participant) {
             const partJid = normalizeJid(cleanMsg.key.participant);
             if (partJid !== myJid && (forcedName || cleanMsg.pushName)) {
                 await upsertContact(partJid, companyId, forcedName || cleanMsg.pushName, null, false);
             }
        }

        // 5. Media Handling
        let mediaUrl = null;
        if (isMedia && isRealtime) {
            mediaUrl = await handleMediaUpload(cleanMsg);
        }

        // 6. Normalização do Tipo
        let messageTypeClean = type?.replace('Message', '') || 'text';
        if (type === 'audioMessage' && cleanMsg.message.audioMessage.ptt) messageTypeClean = 'ptt'; 
        if (type === 'pollCreationMessageV3' || type === 'pollCreationMessage') messageTypeClean = 'poll';

        // 7. Conteúdo Final
        let finalContent = body || (mediaUrl ? '[Mídia]' : '');
        
        // Tratamento especial para Enquetes
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

        // 8. Persistência (DB)
        await upsertMessage({
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
        });

    } catch (e) {
        console.error("❌ [MSG HANDLER] Erro:", e);
    }
};

/**
 * Processa atualizações de status (Ticks Azuis)
 */
export const handleReceiptUpdate = async (events, companyId) => {
    for (const event of events) {
        const receiptStatus = event.receipt.status;
        let dbStatus = null;

        // Mapeamento Baileys -> Wancora
        if (receiptStatus === 3) dbStatus = 'delivered'; // 3: DELIVERY_ACK
        else if (receiptStatus === 4 || receiptStatus === 5) dbStatus = 'read'; // 4: READ, 5: PLAYED
        
        if (!dbStatus) continue;

        const updates = { status: dbStatus };
        if (dbStatus === 'delivered') updates.delivered_at = new Date();
        if (dbStatus === 'read') updates.read_at = new Date();

        await supabase.from('messages')
            .update(updates)
            .eq('whatsapp_id', event.key.id)
            .eq('company_id', companyId);
    }
};

/**
 * Processa reações e votos em enquetes
 */
export const handleMessageUpdate = async (updates, companyId) => {
    for (const update of updates) {
        // Lógica de Enquete (Poll Vote)
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
                    // Remove voto anterior desse usuário (Single Choice logic protection)
                    currentVotes = currentVotes.filter(v => v.voterJid !== voterJid);

                    if (selectedOptions.length > 0) {
                            selectedOptions.forEach(opt => {
                                const optName = opt.name || 'Desconhecido';
                                const idx = pollData.options?.findIndex(o => o === optName);
                                
                                currentVotes.push({
                                    voterJid,
                                    optionId: idx !== -1 ? idx : 0,
                                    ts: Date.now(),
                                    selectedOptions: [optName] // Salva nome legível
                                });
                            });
                    }

                    await supabase.from('messages')
                        .update({ poll_votes: currentVotes })
                        .eq('whatsapp_id', pollCreationKey.id)
                        .eq('company_id', companyId);
                }
            }
        }
    }
};

/**
 * Processa reações (Emojis)
 */
export const handleReaction = async (reactions, sock, companyId) => {
    for (const reaction of reactions) {
        const { key, text } = reaction;
        if (!key.id) continue;

        const myJid = normalizeJid(sock.user?.id);
        const reactorJid = normalizeJid(reaction.key.participant || reaction.key.remoteJid || myJid);

        const { data: msg } = await supabase
            .from('messages')
            .select('reactions')
            .eq('whatsapp_id', key.id)
            .eq('company_id', companyId)
            .single();

        if (msg) {
            let currentReactions = Array.isArray(msg.reactions) ? msg.reactions : [];
            // Remove reação anterior do mesmo ator
            currentReactions = currentReactions.filter(r => r.actor !== reactorJid);
            
            // Se text existe, é uma nova reação. Se for null/empty, é remoção.
            if (text) {
                currentReactions.push({ text, actor: reactorJid, ts: Date.now() });
            }
            
            await supabase
                .from('messages')
                .update({ reactions: currentReactions })
                .eq('whatsapp_id', key.id)
                .eq('company_id', companyId);
        }
    }
};
