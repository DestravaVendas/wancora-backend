
import {
    upsertContact,
    upsertMessage,
    upsertMessagesBatch, // NOVA FUNÇÃO
    ensureLeadExists,
    updateSyncStatus,
    normalizeJid
} from '../crm/sync.js';
import {
    downloadMediaMessage,
    getContentType
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

const getBody = (msg) => {
    if (!msg) return '';
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    return ''; 
};

const fetchProfilePicSafe = async (sock, jid) => {
    try {
        await new Promise(r => setTimeout(r, Math.random() * 200 + 100)); 
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
    
    // --- BATCH HISTORY SYNC ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages, isLatest }) => {
        const itemCount = (contacts?.length || 0) + (messages?.length || 0);
        console.log(`📚 [HISTÓRICO] Pacote: ${itemCount} itens (Latest: ${isLatest}). Modo Turbo Ativado 🚀`);

        if (itemCount === 0) {
            if (isLatest) await updateSyncStatus(sessionId, 'completed', 100);
            return;
        }

        try {
            const contactsMap = new Map();

            // 1. Contatos (Otimizado com Batch Size 50)
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
                const CONTACT_BATCH = 50; 
                
                for (let i = 0; i < uniqueJids.length; i += CONTACT_BATCH) {
                    const batchJids = uniqueJids.slice(i, i + CONTACT_BATCH);
                    await Promise.all(batchJids.map(async (jid) => {
                        let data = contactsMap.get(jid);
                        // Logica de enriquecimento (Grupo/Foto) mantida
                        if (jid.includes('@g.us') && !data.name) {
                            const groupName = await fetchGroupSubjectSafe(sock, jid);
                            if (groupName) data.name = groupName;
                        }
                        if (!data.imgUrl) {
                            // Não bloqueia o loop esperando foto em histórico
                            fetchProfilePicSafe(sock, jid).then(url => {
                                if(url) upsertContact(jid, companyId, null, url, false);
                            });
                        }
                        await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook, data.lid);
                    }));
                    
                    if (i % 200 === 0) console.log(`📇 [SYNC CONTATOS] ${Math.min(i + CONTACT_BATCH, uniqueJids.length)}/${uniqueJids.length}`);
                }
            }

            // 2. Name Hunter Light (Scan rápido)
            if (messages && messages.length > 0) {
                messages.forEach(msg => {
                    if (msg.key.fromMe) return;
                    const jid = normalizeJid(msg.key.remoteJid);
                    if (!jid) return;
                    const existing = contactsMap.get(jid);
                    if ((!existing || !existing.name) && msg.pushName) {
                        if (existing) existing.name = msg.pushName; 
                        else contactsMap.set(jid, { name: msg.pushName, imgUrl: null, isFromBook: false, lid: null });
                    }
                });
            }

            // 3. MENSAGENS EM LOTE (CORE FIX)
            if (messages && messages.length > 0) {
                console.log(`💬 [HISTÓRICO] Preparando Batch de ${messages.length} mensagens...`);
                await updateSyncStatus(sessionId, 'importing_messages', 30);
                
                // Agrupa por Chat
                const messagesByChat = new Map();
                messages.forEach(msg => {
                    const unwrapped = unwrapMessage(msg);
                    if(!unwrapped.key?.remoteJid) return;
                    const jid = normalizeJid(unwrapped.key.remoteJid);
                    if (!jid || jid === 'status@broadcast') return;
                    if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                    messagesByChat.get(jid).push(unwrapped);
                });

                const sortedChats = Array.from(messagesByChat.entries()); // Sem sort pesado para economizar CPU
                const myJid = normalizeJid(sock.user?.id); 
                
                let messageBatchBuffer = [];
                let totalProcessed = 0;

                for (let i = 0; i < sortedChats.length; i++) {
                    const [chatJid, chatMsgs] = sortedChats[i];
                    
                    // IMPORTANTE: Garantimos o Lead UMA VEZ por chat, não por mensagem
                    let leadId = null;
                    if (!chatJid.includes('@g.us')) {
                        const mapData = contactsMap.get(chatJid);
                        // Tenta pegar o melhor nome disponível no mapa
                        const bestName = mapData?.name || chatMsgs.find(m => !m.key.fromMe && m.pushName)?.pushName;
                        leadId = await ensureLeadExists(chatJid, companyId, bestName, myJid);
                    }

                    // Prepara objetos para insert (sem IO de banco individual)
                    // Pega as últimas 50 mensagens por chat para não floodar
                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    const msgsToSave = chatMsgs.slice(-50); 

                    for (const msg of msgsToSave) {
                        const body = getBody(msg.message);
                        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
                        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
                        
                        if (!body && !isMedia) continue;

                        messageBatchBuffer.push({
                            company_id: companyId,
                            session_id: sessionId,
                            remote_jid: chatJid,
                            whatsapp_id: msg.key.id,
                            from_me: msg.key.fromMe,
                            content: body || (isMedia ? '[Mídia Histórica]' : ''),
                            media_url: null, // Histórico não baixa mídia para performance
                            message_type: type?.replace('Message', '') || 'text',
                            status: msg.key.fromMe ? 'sent' : 'received',
                            lead_id: leadId,
                            created_at: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000)
                        });
                    }

                    totalProcessed += msgsToSave.length;

                    // Flush do Buffer a cada 200 mensagens ou 20 chats
                    if (messageBatchBuffer.length >= 200 || i % 20 === 0) {
                        await upsertMessagesBatch(messageBatchBuffer);
                        messageBatchBuffer = []; // Limpa buffer
                        
                        // Atualiza progresso visual
                        const progress = 30 + Math.floor((i / sortedChats.length) * 65);
                        await updateSyncStatus(sessionId, 'importing_messages', progress);
                    }
                }

                // Flush final
                if (messageBatchBuffer.length > 0) {
                    await upsertMessagesBatch(messageBatchBuffer);
                }
                
                console.log(`✅ [SYNC BATCH] Finalizado. Total: ${totalProcessed} msgs.`);
            }

        } catch (e) {
            console.error("❌ [SYNC ERROR]", e);
        } finally {
            if (isLatest) {
                console.log(`✅ [SYNC] 100% Completo. UI Liberada.`);
                await updateSyncStatus(sessionId, 'completed', 100);
            } else {
                await updateSyncStatus(sessionId, 'importing_messages', 99);
            }
        }
    });

    // --- REALTIME (MANTIDO ESTRUTURA ORIGINAL SEGURA) ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            if (!addToCache(msg.key.id)) continue;

            const clean = unwrapMessage(msg);
            const jid = normalizeJid(clean.key.remoteJid);
            
            if (jid && !clean.key.fromMe) { 
                 fetchProfilePicSafe(sock, jid).then(url => {
                     if(url) upsertContact(jid, companyId, clean.pushName, url, false);
                 });
            }
            // Realtime continua processando um por um para baixar mídia e gatilhos
            await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName);
        }
    });
    
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

// Mantido para Realtime
const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null) => {
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

        let leadId = null;
        if (jid && !jid.includes('@g.us')) {
            leadId = await ensureLeadExists(jid, companyId, forcedName, myJid);
            
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
        });

    } catch (e) {
        console.error("Erro processSingleMessage:", e);
    }
};
