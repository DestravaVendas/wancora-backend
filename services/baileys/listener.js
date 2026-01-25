import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    updateSyncStatus,
    normalizeJid,
    savePollVote
} from '../crm/sync.js';
import {
    downloadMediaMessage,
    getContentType,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'silent' });

const msgCache = new Set();
const addToCache = (id) => {
    if (msgCache.has(id)) return false;
    msgCache.add(id);
    setTimeout(() => msgCache.delete(id), 10000); 
    return true;
};

// Utilitário para desenrolar mensagens complexas
const unwrapMessage = (msg) => {
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

const uploadMedia = async (buffer, type) => {
    try {
        const ext = mime.extension(type) || 'bin';
        const fileName = `hist_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        
        const { error } = await supabase.storage
            .from('chat-media')
            .upload(fileName, buffer, { contentType: type, upsert: false });
            
        if (error) {
            console.error("Erro Supabase Storage:", error.message);
            return null;
        }
        
        const { data } = supabase.storage.from('chat-media').getPublicUrl(fileName);
        return data.publicUrl;
    } catch (e) { 
        console.error("Erro uploadMedia:", e);
        return null; 
    }
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

const fetchProfilePicSafe = async (sock, jid) => {
    try {
        await new Promise(r => setTimeout(r, Math.random() * 500 + 200)); 
        const url = await sock.profilePictureUrl(jid, 'image'); 
        return url;
    } catch (e) { return null; }
};

const fetchGroupSubjectSafe = async (sock, jid) => {
    try {
        await new Promise(r => setTimeout(r, 300)); 
        const metadata = await sock.groupMetadata(jid);
        return metadata.subject;
    } catch (e) { return null; }
};

export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    let totalProcessedMessages = 0;

    // -----------------------------------------------------------
    // 0. GATILHO IMEDIATO DE SYNC (ZERO GAP)
    // -----------------------------------------------------------
    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log(`⚡ [LISTENER] Conexão aberta! Forçando status 'importing' imediatamente.`);
            await updateSyncStatus(sessionId, 'importing_contacts', 5);
        }
    });

    // -----------------------------------------------------------
    // 1. PRESENÇA
    // -----------------------------------------------------------
    sock.ev.on('presence.update', async (presenceUpdate) => {
        const id = presenceUpdate.id;
        const presences = presenceUpdate.presences;
        
        if (presences[id]) {
            const lastKnown = presences[id].lastKnownPresence;
            const isOnline = lastKnown === 'composing' || lastKnown === 'recording' || lastKnown === 'available';
            
            supabase.from('contacts')
                .update({ is_online: isOnline, last_seen_at: new Date().toISOString() })
                .eq('jid', normalizeJid(id))
                .eq('company_id', companyId)
                .then(() => {});
        }
    });

    // -----------------------------------------------------------
    // 2. ATUALIZAÇÕES (ENQUETES V6)
    // -----------------------------------------------------------
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            // Tratamento de Votos em Enquete
            if (update.pollUpdates) {
                const pollCreationKey = update.key;
                if (!pollCreationKey) continue;

                for (const pollUpdate of update.pollUpdates) {
                    const vote = pollUpdate.vote;
                    if (!vote) continue;
                    
                    const voterJid = normalizeJid(pollUpdate.pollUpdateMessageKey?.participant || pollUpdate.pollUpdateMessageKey?.remoteJid);
                    const selectedOptions = vote.selectedOptions || [];
                    
                    // Recupera mensagem original
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
                        // Remove voto anterior desse usuário para evitar duplicidade
                        currentVotes = currentVotes.filter(v => v.voterJid !== voterJid);

                        if (selectedOptions.length > 0) {
                             selectedOptions.forEach(opt => {
                                 // Tenta achar index pelo nome (Baileys v6+)
                                 const optName = opt.name || 'Desconhecido';
                                 // Procura o index da opção no array original da enquete
                                 const idx = pollData.options?.findIndex(o => o === optName);
                                 
                                 currentVotes.push({
                                     voterJid,
                                     optionId: idx !== -1 ? idx : 0,
                                     ts: Date.now()
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
    });

    // -----------------------------------------------------------
    // 3. HISTÓRICO DE MENSAGENS (SYNC PURO - LOTE ÚNICO/CONTÍNUO)
    // -----------------------------------------------------------
    sock.ev.on('messaging-history.set', async ({ contacts, messages, isLatest }) => {
        
        console.log(`📚 [HISTÓRICO] Recebido lote de histórico. Processando...`);

        // Não bloqueamos mais se o contador > 1. Deixamos o Baileys mandar tudo o que tiver.
        // Apenas verificamos se já está marcado como "completed" para não reprocessar à toa se a conexão cair e voltar rápido.
        const { data: currentInstance } = await supabase.from('instances').select('sync_status').eq('session_id', sessionId).eq('company_id', companyId).single();
        if (currentInstance?.sync_status === 'completed') {
            console.log("⏩ [HISTÓRICO] Sync já completado anteriormente. Ignorando.");
            return;
        }

        try {
            const contactsMap = new Map();

            // A. Contatos (Mantém lógica original eficiente)
            if (contacts && contacts.length > 0) {
                await updateSyncStatus(sessionId, 'importing_contacts', 10);
                
                contacts.forEach(c => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    contactsMap.set(jid, { name: c.name || c.verifiedName || c.notify, imgUrl: c.imgUrl, isFromBook: !!c.name, lid: c.lid || null });
                });

                const uniqueJids = Array.from(contactsMap.keys());
                const BATCH_SIZE = 10; 
                
                for (let i = 0; i < uniqueJids.length; i += BATCH_SIZE) {
                    const batchJids = uniqueJids.slice(i, i + BATCH_SIZE);
                    await Promise.all(batchJids.map(async (jid) => {
                        let data = contactsMap.get(jid);
                        if (jid.includes('@g.us') && !data.name) {
                            const groupName = await fetchGroupSubjectSafe(sock, jid);
                            if (groupName) data.name = groupName;
                        }
                        if (!data.imgUrl) {
                            const freshPic = await fetchProfilePicSafe(sock, jid);
                            if (freshPic) data.imgUrl = freshPic;
                        }
                        await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook, data.lid);
                    }));
                    await new Promise(r => setTimeout(r, 20)); 
                }
            }

            // B. Mensagens (Processamento em Lote Único)
            if (messages && messages.length > 0) {
                // Name Hunter
                messages.forEach(msg => {
                    if (msg.key.fromMe) return;
                    const jid = normalizeJid(msg.key.remoteJid);
                    if (!jid) return;
                    const existing = contactsMap.get(jid);
                    if ((!existing || !existing.name) && msg.pushName) {
                        upsertContact(jid, companyId, msg.pushName, null, false);
                    }
                });

                // Organização por Chat
                const messagesByChat = new Map();
                messages.forEach(msg => {
                    const unwrapped = unwrapMessage(msg);
                    if(!unwrapped.key?.remoteJid) return;
                    const jid = normalizeJid(unwrapped.key.remoteJid);
                    if (!jid || jid === 'status@broadcast') return;
                    
                    if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                    messagesByChat.get(jid).push(unwrapped);
                });

                // Flattening para processamento linear com progresso
                let finalMessagesToProcess = [];
                const chats = Array.from(messagesByChat.entries());
                
                chats.forEach(([chatJid, chatMsgs]) => {
                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    // Mantemos o slice(-10) para não sobrecarregar o banco com mensagens de 2015
                    const msgsToSave = chatMsgs.slice(-10); 
                    
                    const mapData = contactsMap.get(chatJid);
                    msgsToSave.forEach(m => {
                        m._forcedName = m.pushName || (mapData ? mapData.name : null);
                    });
                    
                    finalMessagesToProcess.push(...msgsToSave);
                });

                const totalInBatch = finalMessagesToProcess.length;
                let processedInBatch = 0;
                let lastLoggedPercent = 0;

                console.log(`📥 [SYNC] Processando lote de ${totalInBatch} mensagens recentes.`);
                await updateSyncStatus(sessionId, 'importing_messages', 20);

                for (const msg of finalMessagesToProcess) {
                    // IMPORTANTE: Passamos createLead = FALSE aqui.
                    // Isso garante que apenas contatos sejam criados/atualizados, mas NÃO leads no CRM.
                    await processSingleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, false);
                    
                    processedInBatch++;
                    totalProcessedMessages++;

                    // Cálculo visual de progresso (Log a cada 2%)
                    const percent = Math.min(99, Math.floor((processedInBatch / totalInBatch) * 100));
                    if (percent >= lastLoggedPercent + 2) {
                        console.log(`📥 [SYNC] ${processedInBatch}/${totalInBatch} mensagens ${percent}%`);
                        await updateSyncStatus(sessionId, 'importing_messages', percent);
                        lastLoggedPercent = percent;
                    }
                    
                    if (processedInBatch % 50 === 0) await new Promise(r => setTimeout(r, 50));
                }
            }

        } catch (e) {
            console.error("❌ [SYNC ERROR]", e);
        } finally {
            // Se isLatest for true, significa que o Baileys terminou de mandar o histórico.
            if (isLatest) {
                await updateSyncStatus(sessionId, 'completed', 100);
                console.log(`✅ [HISTÓRICO] Sincronização Finalizada Completamente.`);
            }
        }
    });

    // -----------------------------------------------------------
    // 4. MENSAGENS EM TEMPO REAL
    // -----------------------------------------------------------
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            // REVOKE
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
                continue; 
            }

            if (!msg.message) continue;
            if (!addToCache(msg.key.id)) continue;

            const clean = unwrapMessage(msg);
            const jid = normalizeJid(clean.key.remoteJid);
            
            if (jid && !clean.key.fromMe) { 
                 fetchProfilePicSafe(sock, jid).then(url => {
                     if(url) upsertContact(jid, companyId, clean.pushName, url, false);
                 });
            }
            
            // IMPORTANTE: Aqui createLead é TRUE (default), pois mensagens novas em tempo real DEVEM criar leads.
            await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName, true);
        }
    });
    
    // -----------------------------------------------------------
    // 5. STATUS DE LEITURA (TICKS)
    // -----------------------------------------------------------
    sock.ev.on('message-receipt.update', async (events) => {
        for (const event of events) {
            const receiptStatus = event.receipt.status;
            let dbStatus = null;

            if (receiptStatus === 3) dbStatus = 'delivered';
            else if (receiptStatus === 4 || receiptStatus === 5) dbStatus = 'read';
            
            if (!dbStatus) continue;

            const updates = { status: dbStatus };
            if (dbStatus === 'delivered') updates.delivered_at = new Date();
            if (dbStatus === 'read') updates.read_at = new Date();

            await supabase.from('messages')
                .update(updates)
                .eq('whatsapp_id', event.key.id)
                .eq('company_id', companyId);
        }
    });

    // -----------------------------------------------------------
    // 6. REAÇÕES
    // -----------------------------------------------------------
    sock.ev.on('messages.reaction', async (reactions) => {
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
                currentReactions = currentReactions.filter(r => r.actor !== reactorJid);
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
    });

    // -----------------------------------------------------------
    // 7. EVENTOS DE CONTATO
    // -----------------------------------------------------------
    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const c of contacts) {
            const jid = normalizeJid(c.id);
            if (!jid) continue;
            const bestName = c.name || c.verifiedName || c.notify;
            if (bestName || c.imgUrl) {
                await upsertContact(jid, companyId, bestName, c.imgUrl || null, !!c.name, c.lid);
            }
        }
    });

    sock.ev.on('contacts.update', async (updates) => {
        for (const update of updates) {
            const jid = normalizeJid(update.id);
            if (update.imgUrl) {
                await upsertContact(jid, companyId, null, update.imgUrl, false);
            }
        }
    });
};

// Modificada para aceitar createLead param
const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null, createLead = true) => {
    try {
        if (!msg.message) return;
        const jid = normalizeJid(msg.key.remoteJid);
        if (jid === 'status@broadcast') return;

        const body = getBody(msg.message);
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        
        if (!body && !isMedia && type !== 'pollCreationMessageV3') return;

        const fromMe = msg.key.fromMe;
        const myJid = normalizeJid(sock.user?.id); 

        let leadId = null;
        // SÓ CRIA LEAD SE A FLAG PERMITIR E NÃO FOR GRUPO
        if (createLead && jid && !jid.includes('@g.us')) {
            leadId = await ensureLeadExists(jid, companyId, forcedName, myJid);
            
            // Upsert do contato com foto atualizada se for realtime
            if (isRealtime && forcedName && jid !== myJid) {
                await upsertContact(jid, companyId, forcedName, null, false);
            }
        }
        
        if (jid.includes('@g.us') && msg.key.participant && forcedName) {
             const partJid = normalizeJid(msg.key.participant);
             if (partJid !== myJid) {
                 await upsertContact(partJid, companyId, forcedName, null, false);
             }
        }

        let mediaUrl = null;
        if (isMedia && isRealtime) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                let mimeType = 'application/octet-stream';
                if (msg.message?.imageMessage) mimeType = 'image/jpeg';
                else if (msg.message?.audioMessage) mimeType = 'audio/mp4'; 
                else if (msg.message?.videoMessage) mimeType = 'video/mp4';
                else if (msg.message?.documentMessage) mimeType = msg.message.documentMessage.mimetype;
                else if (msg.message?.stickerMessage) mimeType = 'image/webp';

                mediaUrl = await uploadMedia(buffer, mimeType);
            } catch (e) {
                console.error("Erro download media:", e);
            }
        }

        let messageTypeClean = type?.replace('Message', '') || 'text';
        if (type === 'audioMessage' && msg.message.audioMessage.ptt) messageTypeClean = 'ptt'; 
        if (type === 'pollCreationMessageV3' || type === 'pollCreationMessage') messageTypeClean = 'poll';

        let finalContent = body || (mediaUrl ? '[Mídia]' : '');
        
        if (messageTypeClean === 'poll') {
            const pollMsg = msg.message?.pollCreationMessageV3 || msg.message?.pollCreationMessage;
            if (pollMsg) {
                finalContent = JSON.stringify({
                    name: pollMsg.name,
                    options: pollMsg.options.map(o => o.optionName),
                    selectableOptionsCount: pollMsg.selectableOptionsCount
                });
            }
        }

        await upsertMessage({
            company_id: companyId,
            session_id: sessionId,
            remote_jid: jid,
            whatsapp_id: msg.key.id,
            from_me: fromMe,
            content: finalContent,
            media_url: mediaUrl,
            message_type: messageTypeClean,
            status: fromMe ? 'sent' : 'received',
            lead_id: leadId,
            created_at: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000)
        });

    } catch (e) {
        console.error("Erro processSingleMessage:", e);
    }
};
