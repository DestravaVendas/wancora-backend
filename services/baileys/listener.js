
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

// Safe Profile Pic Fetcher
const fetchProfilePicSafe = async (sock, jid) => {
    try {
        // Tenta obter foto. Funciona para grupos e usuarios.
        // Adiciona um delay aleatório minúsculo para evitar rate-limit
        await new Promise(r => setTimeout(r, Math.random() * 200));
        const url = await sock.profilePictureUrl(jid, 'image'); 
        return url;
    } catch (e) {
        return null; // 404 ou 401 normal se não tiver foto
    }
};

export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // --- HISTÓRICO COMPLETO ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        if (isProcessingHistory) return;
        isProcessingHistory = true;

        try {
            console.log(`📚 [HISTÓRICO] Iniciando Sync... Sessão: ${sessionId}`);
            // Feedback inicial imediato
            await updateSyncStatus(sessionId, 'importing_contacts', 5);

            const contactsMap = new Map();

            // 1. Mapeia Contatos da Agenda (Sem salvar ainda)
            if (contacts && contacts.length > 0) {
                console.log(`📇 [AGENDA] Processando ${contacts.length} contatos...`);
                
                await Promise.all(contacts.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    const bestName = c.name || c.verifiedName || c.notify;
                    contactsMap.set(jid, { 
                        name: bestName, 
                        imgUrl: c.imgUrl, 
                        isFromBook: !!bestName,
                        lid: c.lid || null // Captura LID se disponível
                    });
                }));
            }

            // 2. Scan de Mensagens para enriquecer nomes (PushName)
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

            // 3. Salva Contatos e Busca Fotos (Lote Controlado com UNBLOCK)
            const uniqueJids = Array.from(contactsMap.keys());
            const BATCH_SIZE = 10; 
            let processedContacts = 0;
            
            for (let i = 0; i < uniqueJids.length; i += BATCH_SIZE) {
                const batchJids = uniqueJids.slice(i, i + BATCH_SIZE);
                
                await Promise.all(batchJids.map(async (jid) => {
                    let data = contactsMap.get(jid);
                    
                    // FETCH FOTO: Agora permitido para grupos também!
                    if (!data.imgUrl) {
                        const freshPic = await fetchProfilePicSafe(sock, jid);
                        if (freshPic) data.imgUrl = freshPic;
                    }

                    await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook, data.lid);
                }));

                processedContacts += batchJids.length;
                
                // --- PONTO CRÍTICO: UNBLOCK EVENT LOOP ---
                // Isso permite que o Node processe outras tarefas (como o HTTP request do updateSyncStatus ou WebSockets)
                // impedindo o travamento da UI durante loops pesados.
                await new Promise(r => setTimeout(r, 0)); 
                
                const percent = 5 + Math.floor((processedContacts / uniqueJids.length) * 25);
                // Atualiza status no banco a cada 10% para não spamar
                if (processedContacts % 50 === 0) {
                    await updateSyncStatus(sessionId, 'importing_contacts', percent);
                }
            }

            // 4. Processa Mensagens
            if (messages && messages.length > 0) {
                await updateSyncStatus(sessionId, 'importing_messages', 30);
                
                // Organiza mensagens por chat para processar as mais recentes
                const messagesByChat = new Map();
                messages.forEach(msg => {
                    const unwrapped = unwrapMessage(msg);
                    if(!unwrapped.key?.remoteJid) return;
                    const jid = normalizeJid(unwrapped.key.remoteJid);
                    if (!jid || jid === 'status@broadcast') return;
                    if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                    messagesByChat.get(jid).push(unwrapped);
                });

                // Prioriza chats com atividade recente
                const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
                    const tA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
                    const tB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
                    return tB - tA; 
                });

                const topChats = sortedChats.slice(0, 150); // Limite de chats iniciais
                
                for (let i = 0; i < topChats.length; i++) {
                    const [chatJid, chatMsgs] = topChats[i];
                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    const msgsToSave = chatMsgs.slice(-30); // Aumentado limite por chat

                    for (const msg of msgsToSave) {
                        const mapData = contactsMap.get(chatJid);
                        const forcedName = msg.pushName || (mapData ? mapData.name : null);
                        
                        // Passamos o ID do bot para evitar auto-criação de lead
                        await processSingleMessage(msg, sock, companyId, sessionId, false, forcedName);
                    }

                    // Unblock Event Loop
                    await new Promise(r => setTimeout(r, 0));

                    const percent = 30 + Math.floor((i / topChats.length) * 70);
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
            
            // BUSCA FOTO REATIVA
            // Se receber msg e não tiver foto ou for grupo, tenta buscar
            if (jid && !clean.key.fromMe) { 
                 fetchProfilePicSafe(sock, jid).then(url => {
                     // Atualiza silenciosamente se achar foto nova
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
        
        // --- IDENTIFICAÇÃO DO BOT (CRÍTICO) ---
        // Pega o ID normalizado do bot conectado para evitar criar Lead de si mesmo
        const myJid = normalizeJid(sock.user?.id); 

        // 1. GARANTE ESTRUTURA (Com Proteção Self-Lead)
        let leadId = null;
        if (jid && !jid.includes('@g.us')) {
            // Passa o ID do bot. Se jid == myJid, ensureLeadExists retorna null.
            leadId = await ensureLeadExists(jid, companyId, forcedName, myJid);
            
            // Só atualiza contato se for realtime e não for eu mesmo
            if (isRealtime && forcedName && jid !== myJid) {
                await upsertContact(jid, companyId, forcedName, null, false);
            }
        }
        
        // Em grupos, garante o participante
        if (jid.includes('@g.us') && msg.key.participant && forcedName) {
             const partJid = normalizeJid(msg.key.participant);
             if (partJid !== myJid) {
                 await upsertContact(partJid, companyId, forcedName, null, false);
             }
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
