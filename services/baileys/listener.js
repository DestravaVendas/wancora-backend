
import {
    upsertContact,
    upsertMessage,
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

let isProcessingHistory = false;

// --- HELPERS ---
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

// Fetch Inteligente: Tenta obter URL. Se falhar ou vier vazia, não crasha.
const fetchProfilePicSafe = async (sock, jid) => {
    try {
        // Random delay para não tomar 429 Too Many Requests
        await new Promise(r => setTimeout(r, Math.random() * 800));
        return await sock.profilePictureUrl(jid, 'image'); 
    } catch (e) {
        return null; 
    }
};

export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // --- HISTÓRICO COMPLETO ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        if (isProcessingHistory) return;
        isProcessingHistory = true;

        try {
            console.log(`📚 [HISTÓRICO] Iniciando Sync... Sessão: ${sessionId}`);
            await updateSyncStatus(sessionId, 'importing_contacts', 5);

            const contactsMap = new Map();

            // 1. Processa Contatos (Lote com Extração de LID)
            if (contacts && contacts.length > 0) {
                console.log(`📇 [AGENDA] Processando ${contacts.length} contatos...`);
                
                await Promise.all(contacts.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    const bestName = c.name || c.verifiedName || c.notify;
                    // Extrai LID se disponível (Baileys as vezes manda no objeto contact)
                    const lid = c.lid || null; 
                    
                    contactsMap.set(jid, { 
                        name: bestName, 
                        imgUrl: c.imgUrl, 
                        isFromBook: !!bestName,
                        lid: lid 
                    });
                }));
            }

            // 2. Scan PushNames
            if (messages && messages.length > 0) {
                messages.forEach(msg => {
                    if (msg.key.fromMe) return;
                    const jid = normalizeJid(msg.key.remoteJid);
                    if (!jid) return;

                    if (!contactsMap.has(jid)) {
                        contactsMap.set(jid, { name: msg.pushName, imgUrl: null, isFromBook: false, lid: null });
                    }
                });
            }

            // 3. Salva Contatos (Lote Controlado com Progresso Real)
            const uniqueJids = Array.from(contactsMap.keys());
            const BATCH_SIZE = 10; // Reduzido para garantir fetch de fotos
            let processedContacts = 0;
            
            for (let i = 0; i < uniqueJids.length; i += BATCH_SIZE) {
                const batchJids = uniqueJids.slice(i, i + BATCH_SIZE);
                
                await Promise.all(batchJids.map(async (jid) => {
                    let data = contactsMap.get(jid);
                    
                    // DEEP FETCH: Busca foto se não tiver
                    if (!data.imgUrl && !jid.includes('@g.us')) {
                        const freshPic = await fetchProfilePicSafe(sock, jid);
                        if (freshPic) data.imgUrl = freshPic;
                    }

                    // Passa o LID para mapeamento no sync.js
                    await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook, data.lid);
                }));

                processedContacts += batchJids.length;
                
                // ATUALIZAÇÃO PROGRESSIVA (Evita "travamento" da barra)
                const percent = 5 + Math.floor((processedContacts / uniqueJids.length) * 25); // Vai de 5% a 30%
                if (percent % 5 === 0) {
                    await updateSyncStatus(sessionId, 'importing_contacts', percent);
                }
            }

            // 4. Processa Mensagens (Lote Controlado)
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

                const topChats = sortedChats.slice(0, 200); 
                let processedMsgs = 0;
                const totalMsgs = topChats.reduce((acc, [, msgs]) => acc + msgs.length, 0);
                
                for (let i = 0; i < topChats.length; i++) {
                    const [chatJid, chatMsgs] = topChats[i];
                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    const msgsToSave = chatMsgs.slice(-25); // Top 25

                    for (const msg of msgsToSave) {
                        const mapData = contactsMap.get(chatJid);
                        const forcedName = msg.pushName || (mapData ? mapData.name : null);
                        await processSingleMessage(msg, sock, companyId, sessionId, false, forcedName);
                        processedMsgs++;
                    }

                    // ATUALIZAÇÃO PROGRESSIVA DE MENSAGENS
                    const percent = 30 + Math.floor((i / topChats.length) * 70); // Vai de 30% a 100%
                    if (i % 5 === 0) {
                        await updateSyncStatus(sessionId, 'importing_messages', percent);
                    }
                }
            }

            await updateSyncStatus(sessionId, 'completed', 100);

        } catch (e) {
            console.error("History Sync Error:", e);
        } finally {
            setTimeout(() => { isProcessingHistory = false; }, 15000);
        }
    });

    // --- REALTIME MESSAGES ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            if (!addToCache(msg.key.id)) continue;

            const clean = unwrapMessage(msg);
            const jid = normalizeJid(clean.key.remoteJid);
            
            // BUSCA FOTO REATIVA (Ao receber mensagem de desconhecido)
            if (jid && !clean.key.fromMe && !clean.key.participant && jid.includes('@s.whatsapp.net')) { 
                 fetchProfilePicSafe(sock, jid).then(url => {
                     // Atualiza contato silenciosamente com a nova foto
                     if(url) upsertContact(jid, companyId, clean.pushName, url, false);
                 });
            }
            
            await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName);
        }
    });
    
    // --- ATUALIZAÇÃO DE CONTATOS (Foto/Nome) ---
    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const c of contacts) {
            const jid = normalizeJid(c.id);
            if (!jid) continue;
            const bestName = c.name || c.verifiedName || c.notify;
            // Passa LID se existir no update
            await upsertContact(jid, companyId, bestName, c.imgUrl || null, !!c.name, c.lid);
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

        // 1. GARANTE ESTRUTURA (Lead & Contato & LID Map)
        let leadId = null;
        if (jid && !jid.includes('@g.us')) {
            // Se for realtime, garantimos que o contato existe e tentamos mapear LID
            // msg.key.id as vezes contém pistas, mas o melhor é deixar o upsertContact lidar com isso
            leadId = await ensureLeadExists(jid, companyId, forcedName);
            
            if (isRealtime && forcedName) {
                // Atualiza pushname
                await upsertContact(jid, companyId, forcedName, null, false);
            }
        }
        
        if (jid.includes('@g.us') && msg.key.participant && forcedName) {
             const partJid = normalizeJid(msg.key.participant);
             await upsertContact(partJid, companyId, forcedName, null, false);
        }

        // 2. MÍDIA
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
            } catch (e) {}
        }

        // 3. SALVA MENSAGEM
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

    } catch (e) {}
};
