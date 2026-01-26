import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    updateSyncStatus,
    normalizeJid
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
// Logger configurado para silenciar logs internos do Baileys e focar nos nossos
const logger = pino({ level: 'silent' });

// Cache simples para evitar processamento duplo de mensagens em milissegundos (debounce)
const msgCache = new Set();
const addToCache = (id) => {
    if (msgCache.has(id)) return false;
    msgCache.add(id);
    setTimeout(() => msgCache.delete(id), 10000); 
    return true;
};

// Utilitário para desenrolar mensagens complexas (ViewOnce, Editadas, etc)
const unwrapMessage = (msg) => {
    if (!msg.message) return msg;
    let content = msg.message;
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    if (content.viewOnceMessage) content = content.viewOnceMessage.message;
    if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
    if (content.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;
    if (content.editedMessage) content = content.editedMessage.message?.protocolMessage?.editedMessage || content.editedMessage.message;
    return { ...msg, message: content };
};

// Upload de Mídia para Supabase Storage (Bucket: chat-media)
const uploadMedia = async (buffer, type) => {
    try {
        const ext = mime.extension(type) || 'bin';
        const fileName = `hist_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        const { error } = await supabase.storage.from('chat-media').upload(fileName, buffer, { contentType: type });
        if (error) return null;
        const { data } = supabase.storage.from('chat-media').getPublicUrl(fileName);
        return data.publicUrl;
    } catch { return null; }
};

// Extração segura do texto da mensagem
const getBody = (msg) => {
    if (!msg) return '';
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    return ''; 
};

// Fetch seguro de Foto de Perfil com Jitter para evitar Rate Limit (429)
const fetchProfilePicSafe = async (sock, jid) => {
    try {
        await new Promise(r => setTimeout(r, Math.random() * 200 + 100)); 
        const url = await sock.profilePictureUrl(jid, 'image'); 
        return url;
    } catch (e) {
        return null; 
    }
};

const fetchGroupSubjectSafe = async (sock, jid) => {
    try {
        await new Promise(r => setTimeout(r, 300)); 
        const metadata = await sock.groupMetadata(jid);
        return metadata.subject;
    } catch (e) {
        return null;
    }
};

export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // Contador de Lotes para Fast Sync (Limita a 2 pacotes)
    let historyChunkCounter = 0;

    // --- 1. PRESENÇA (ONLINE / DIGITANDO / VISTO POR ÚLTIMO) ---
    // Vital para a experiência social do usuário. Atualiza a tabela contacts.
    sock.ev.on('presence.update', async ({ id, presences }) => {
        try {
            const jid = normalizeJid(id);
            // Ignoramos atualizações de presença em grupos para não spammar o banco com updates
            if (!jid || jid.includes('@g.us')) return; 

            // Pega o status do participante
            const participant = Object.values(presences)[0]; 
            if (!participant) return;

            // 'available' = Online
            // 'composing'/'recording' = Digitando/Gravando (Consideramos online também)
            const isOnline = participant.lastKnownPresence === 'available' 
                             || participant.lastKnownPresence === 'composing' 
                             || participant.lastKnownPresence === 'recording';
            
            // Atualiza tabela contacts para o Frontend mostrar a bolinha verde
            await supabase.from('contacts')
                .update({ 
                    is_online: isOnline,
                    last_seen_at: new Date().toISOString()
                })
                .eq('jid', jid)
                .eq('company_id', companyId);

        } catch (e) {
            // Silencioso para não poluir logs com eventos frequentes
        }
    });

    // --- 2. HISTÓRICO DE MENSAGENS (SYNC ROBUSTO) ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages, isLatest }) => {
        historyChunkCounter++;
        const itemCount = (contacts?.length || 0) + (messages?.length || 0);
        console.log(`📚 [HISTÓRICO] Pacote ${historyChunkCounter} recebido: ${itemCount} itens. Processando Fast Sync...`);

        if (itemCount === 0) {
            // Se vier vazio OU se já passamos de 2 lotes, libera o frontend
            if (isLatest || historyChunkCounter >= 2) await updateSyncStatus(sessionId, 'completed', 100);
            return;
        }

        try {
            // Mapa em memória para evitar queries repetitivas durante o processamento do lote
            const contactsMap = new Map();

            // A. Processamento de Contatos
            if (contacts && contacts.length > 0) {
                await updateSyncStatus(sessionId, 'importing_contacts', 10);
                
                contacts.forEach(c => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    const bestName = c.name || c.verifiedName || c.notify;
                    contactsMap.set(jid, { 
                        name: bestName, 
                        imgUrl: c.imgUrl, 
                        isFromBook: !!c.name,
                        lid: c.lid || null 
                    });
                });

                const uniqueJids = Array.from(contactsMap.keys());
                const BATCH_SIZE = 20; 
                
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
                    await new Promise(r => setTimeout(r, 10));
                }
            }

            // B. Scan de Mensagens (Name Hunter)
            if (messages && messages.length > 0) {
                messages.forEach(msg => {
                    if (msg.key.fromMe) return;
                    const jid = normalizeJid(msg.key.remoteJid);
                    if (!jid) return;
                    const existing = contactsMap.get(jid);
                    if (!existing || !existing.name) {
                        if (msg.pushName) {
                            if (existing) existing.name = msg.pushName; 
                            else contactsMap.set(jid, { name: msg.pushName, imgUrl: null, isFromBook: false, lid: null });
                        }
                    }
                });
            }

            // C. Processamento de Mensagens
            if (messages && messages.length > 0) {
                await updateSyncStatus(sessionId, 'importing_messages', 30);
                
                const messagesByChat = new Map();
                messages.forEach(msg => {
                    const unwrapped = unwrapMessage(msg);
                    if(!unwrapped.key?.remoteJid) return;
                    const jid = normalizeJid(unwrapped.key.remoteJid);
                    if (!jid || jid === 'status@broadcast') return;
                    if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                    messagesByChat.get(jid).push(unwrapped);
                });

                const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
                    const tA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
                    const tB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
                    return tB - tA; 
                });

                const topChats = sortedChats.slice(0, 300); 
                
                for (let i = 0; i < topChats.length; i++) {
                    const [chatJid, chatMsgs] = topChats[i];
                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    
                    const msgsToSave = chatMsgs.slice(-10); // Mantém apenas as 10 últimas para Fast Boot

                    for (const msg of msgsToSave) {
                        const mapData = contactsMap.get(chatJid);
                        const forcedName = msg.pushName || (mapData ? mapData.name : null);
                        await processSingleMessage(msg, sock, companyId, sessionId, false, forcedName, true);
                    }

                    await new Promise(r => setTimeout(r, 5));

                    if (i % 10 === 0) {
                        const progress = 30 + Math.floor((i / topChats.length) * 65);
                        await updateSyncStatus(sessionId, 'importing_messages', progress);
                    }
                }
            }

        } catch (e) {
            console.error("❌ [CRITICAL SYNC ERROR]", e);
        } finally {
            if (isLatest || historyChunkCounter >= 2) {
                await updateSyncStatus(sessionId, 'completed', 100);
            } else {
                await updateSyncStatus(sessionId, 'importing_messages', 99);
            }
        }
    });

    // --- 3. MENSAGENS EM TEMPO REAL ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            const protocolMsg = msg.message?.protocolMessage;
            
            // Tratamento de Revoke (Mensagem Apagada)
            if (protocolMsg && protocolMsg.type === 0) {
                const keyToRevoke = protocolMsg.key;
                if (keyToRevoke && keyToRevoke.id) {
                    await supabase.from('messages')
                        .update({ 
                            content: '🚫 Mensagem apagada', 
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
            
            // Atualiza foto do contato se possível
            if (jid && !clean.key.fromMe) { 
                 fetchProfilePicSafe(sock, jid).then(url => {
                     if(url) upsertContact(jid, companyId, clean.pushName, url, false);
                 });
            }
            
            await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName, false);
        }
    });

    // --- 4. VOTOS DE ENQUETE (REALTIME) ---
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.pollUpdates) {
                for (const pollUpdate of update.pollUpdates) {
                    const messageId = update.key.id;
                    const voterJid = normalizeJid(pollUpdate.senderTimestampMs ? update.key.remoteJid : undefined);
                    
                    try {
                        const { data: currentMsg } = await supabase
                            .from('messages')
                            .select('poll_votes')
                            .eq('whatsapp_id', messageId)
                            .eq('company_id', companyId)
                            .single();
                            
                        if (currentMsg) {
                            let votes = Array.isArray(currentMsg.poll_votes) ? currentMsg.poll_votes : [];
                            
                            // Adiciona voto bruto. A lógica de decriptação exata é complexa no Baileys,
                            // mas o evento garante que houve uma interação.
                            votes.push({
                                voterJid,
                                ts: Date.now(),
                                raw: pollUpdate.vote
                            });

                            await supabase.from('messages')
                                .update({ poll_votes: votes, updated_at: new Date() }) 
                                .eq('whatsapp_id', messageId)
                                .eq('company_id', companyId);
                        }
                    } catch(err) {
                        console.error("Erro ao processar voto:", err);
                    }
                }
            }
        }
    });
    
    // --- 5. STATUS DE LEITURA (TICKS AZUIS) ---
    sock.ev.on('message-receipt.update', async (events) => {
        for (const event of events) {
            const statusMap = {
                1: 'sent',       // Clock/One Check
                2: 'delivered',  // Two Checks Gray
                3: 'read',       // Two Checks Blue
                4: 'played'      // Microphone Blue
            };
            const newStatus = statusMap[event.receipt.status];

            if (newStatus) {
                const updates = { status: newStatus };
                if (newStatus === 'delivered') updates.delivered_at = new Date();
                if (newStatus === 'read') updates.read_at = new Date();

                await supabase.from('messages')
                    .update(updates)
                    .eq('whatsapp_id', event.key.id)
                    .eq('company_id', companyId);
            }
        }
    });

    // --- 6. REAÇÕES (EMOJIS) ---
    sock.ev.on('messages.reaction', async (reactions) => {
        for (const reaction of reactions) {
            const { key, text } = reaction;
            if (!key.id) continue;

            const myJid = normalizeJid(sock.user?.id);
            const reactorJid = normalizeJid(reaction.key.participant || reaction.key.remoteJid || myJid);

            const { data: msg } = await supabase.from('messages')
                .select('reactions')
                .eq('whatsapp_id', key.id)
                .eq('company_id', companyId)
                .single();

            if (msg) {
                let currentReactions = Array.isArray(msg.reactions) ? msg.reactions : [];
                
                // Remove reação anterior deste usuário (para evitar duplicatas ou permitir troca)
                currentReactions = currentReactions.filter(r => r.actor !== reactorJid);
                
                // Se 'text' existe, é uma nova reação. Se for null/undefined, foi uma remoção.
                if (text) {
                    currentReactions.push({ text, actor: reactorJid, ts: Date.now() });
                }
                
                await supabase.from('messages')
                    .update({ reactions: currentReactions })
                    .eq('whatsapp_id', key.id)
                    .eq('company_id', companyId);
            }
        }
    });

    // --- 7. ATUALIZAÇÃO DE CONTATOS ---
    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const c of contacts) {
            const jid = normalizeJid(c.id);
            if (jid && (c.name || c.notify || c.imgUrl)) {
                await upsertContact(jid, companyId, c.name || c.notify, c.imgUrl || null, !!c.name, c.lid);
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

const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null, ignoreConflict = false) => {
    try {
        if (!msg.message) return;
        const jid = normalizeJid(msg.key.remoteJid);
        if (jid === 'status@broadcast') return;

        const body = getBody(msg.message);
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        
        if (!body && !isMedia) return;

        const fromMe = msg.key.fromMe;
        const myJid = normalizeJid(sock.user?.id); 

        // 1. GARANTE ESTRUTURA (LEAD/CONTATO)
        let leadId = null;
        if (jid && !jid.includes('@g.us')) {
            leadId = await ensureLeadExists(jid, companyId, forcedName, myJid);
            if (isRealtime && forcedName && jid !== myJid) {
                await upsertContact(jid, companyId, forcedName, null, false);
            }
        }
        
        // Atualiza quem mandou a mensagem no grupo
        if (jid.includes('@g.us') && msg.key.participant && forcedName) {
             const partJid = normalizeJid(msg.key.participant);
             if (partJid !== myJid) {
                 await upsertContact(partJid, companyId, forcedName, null, false);
             }
        }

        // 2. DOWNLOAD E UPLOAD DE MÍDIA
        let mediaUrl = null;
        if (isMedia && isRealtime) {
            try {
                const mediaContent = msg.message[type];
                const fileLength = Number(mediaContent?.fileLength || 0);
                const MAX_SIZE_BYTES = 32 * 1024 * 1024; // 32MB

                if (fileLength > MAX_SIZE_BYTES) {
                    console.warn(`⚠️ [MÍDIA] Arquivo muito grande (${(fileLength/1024/1024).toFixed(2)}MB). Ignorando download.`);
                    body += ' [Arquivo Grande - Não baixado]';
                } else {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                    let mimeType = 'application/octet-stream';
                    if (msg.message?.imageMessage) mimeType = 'image/jpeg';
                    else if (msg.message?.audioMessage) mimeType = 'audio/mp4'; 
                    else if (msg.message?.videoMessage) mimeType = 'video/mp4';
                    else if (msg.message?.documentMessage) mimeType = msg.message.documentMessage.mimetype;
                    else if (msg.message?.stickerMessage) mimeType = 'image/webp';

                    mediaUrl = await uploadMedia(buffer, mimeType);
                }
            } catch (e) {
                console.error("Erro download media:", e);
            }
        }

        // 3. PERSISTÊNCIA DA MENSAGEM
        await upsertMessage({
            company_id: companyId,
            session_id: sessionId,
            remote_jid: jid,
            whatsapp_id: msg.key.id,
            from_me: fromMe,
            content: body || (mediaUrl ? '[Mídia]' : ''),
            media_url: mediaUrl,
            message_type: type?.replace('Message', '') || 'text',
            status: fromMe ? 'sent' : 'received',
            lead_id: leadId,
            created_at: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000)
        }, ignoreConflict);

    } catch (e) {
        console.error("Erro processSingleMessage:", e);
    }
};
