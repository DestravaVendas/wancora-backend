
import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    updateSyncStatus,
    normalizeJid // Importante: Importar a função de normalização
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

// --- MEMORY CACHE (DEDUPLICAÇÃO) ---
const msgCache = new Set();
const addToCache = (id) => {
    if (msgCache.has(id)) return false;
    msgCache.add(id);
    setTimeout(() => msgCache.delete(id), 10000); 
    return true;
};

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
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;
    if (msg.imageMessage) return '[Imagem]';
    if (msg.videoMessage) return '[Vídeo]';
    if (msg.stickerMessage) return '[Sticker]';
    if (msg.audioMessage) return '[Áudio]';
    if (msg.pttMessage) return '[Mensagem de Voz]';
    if (msg.documentMessage) return msg.documentMessage.fileName || '[Documento]';
    if (msg.contactMessage) return `[Contato: ${msg.contactMessage.displayName}]`;
    if (msg.locationMessage) return '[Localização]';
    if (msg.pollCreationMessage || msg.pollCreationMessageV3) return (msg.pollCreationMessage?.name || msg.pollCreationMessageV3?.name) || '[Enquete]';
    return ''; 
};

const fetchProfilePicSafe = async (sock, jid) => {
    try {
        return await sock.profilePictureUrl(jid, 'image'); 
    } catch (e) {
        return null; 
    }
};

// ==============================================================================
// CONFIGURAÇÃO DOS LISTENERS
// ==============================================================================
export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // --- HISTÓRICO COMPLETO ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        try {
            console.log(`📚 [HISTÓRICO] Iniciando Sync... Sessão: ${sessionId}`);
            await updateSyncStatus(sessionId, 'importing_contacts', 5);

            // 1. SYNC AGENDA (Priority 1)
            // Itera explicitamente sobre o array de contatos para salvar no banco
            if (contacts && contacts.length > 0) {
                console.log(`📇 [AGENDA] Processando ${contacts.length} contatos da agenda...`);
                
                // Processa em lotes para não travar o loop de eventos
                const BATCH_SIZE = 50;
                for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                    const batch = contacts.slice(i, i + BATCH_SIZE);
                    await Promise.all(batch.map(async (c) => {
                        // NORMALIZA JID AQUI TAMBÉM
                        const jid = normalizeJid(c.id);
                        if (!jid || jid.includes('status@')) return;

                        // Nome da Agenda (Notify ou Name)
                        const bestName = c.name || c.verifiedName || c.notify;
                        let picUrl = c.imgUrl || null;
                        
                        // isFromBook = true força o nome da agenda a prevalecer
                        // E o sync.js vai criar o Lead se ele não existir
                        await upsertContact(jid, companyId, bestName, picUrl, true);
                    }));
                }
            }

            // 2. PROCESSAR MENSAGENS (Histórico)
            if (messages && messages.length > 0) {
                await updateSyncStatus(sessionId, 'importing_messages', 30);
                
                const messagesByChat = new Map();
                messages.forEach(msg => {
                    const unwrapped = unwrapMessage(msg);
                    if(!unwrapped.key?.remoteJid) return;
                    
                    // NORMALIZAÇÃO DE CHAT
                    const jid = normalizeJid(unwrapped.key.remoteJid);
                    if (jid === 'status@broadcast') return;
                    
                    if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                    messagesByChat.get(jid).push(unwrapped);
                });

                const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
                    const tA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
                    const tB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
                    return tB - tA; 
                });

                const topChats = sortedChats.slice(0, 200); 
                let processed = 0;
                
                for (const [chatJid, chatMsgs] of topChats) {
                    fetchProfilePicSafe(sock, chatJid).then(url => {
                        if (url) upsertContact(chatJid, companyId, null, url, false);
                    });

                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    const msgsToSave = chatMsgs.slice(-10);

                    for (const msg of msgsToSave) {
                        const pushName = msg.pushName;
                        await processSingleMessage(msg, sock, companyId, sessionId, false, pushName);
                    }
                    processed += msgsToSave.length;
                }
                console.log(`✅ [HISTÓRICO] Processadas ${processed} mensagens.`);
            }

            await updateSyncStatus(sessionId, 'completed', 100);

        } catch (e) {
            console.error("History Sync Error:", e);
        }
    });

    // --- REALTIME MESSAGES ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            
            // DEDUPLICAÇÃO EM MEMÓRIA
            if (!addToCache(msg.key.id)) {
                continue;
            }

            const clean = unwrapMessage(msg);
            
            // Normaliza JID para buscar foto corretamente e para processamento
            const jid = normalizeJid(clean.key.remoteJid);
            
            // Busca foto se for um contato novo interagindo agora (e não for grupo)
            if (jid && !clean.key.fromMe && !clean.key.participant && jid.includes('@s.whatsapp.net')) { 
                 fetchProfilePicSafe(sock, jid).then(url => {
                     if(url) upsertContact(jid, companyId, clean.pushName, url, false);
                 });
            }
            
            await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName);
        }
    });
    
    sock.ev.on('contacts.update', async (updates) => {
        for (const update of updates) {
            if (update.imgUrl) {
                const jid = normalizeJid(update.id);
                await upsertContact(jid, companyId, null, update.imgUrl, false);
            }
        }
    });
};

const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null) => {
    try {
        if (!msg.message) return;
        const jid = normalizeJid(msg.key.remoteJid); // NORMALIZAÇÃO AQUI
        if (jid === 'status@broadcast') return;

        const body = getBody(msg.message);
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        
        if (!body && !isMedia) return;

        const fromMe = msg.key.fromMe;

        // 1. GARANTE ESTRUTURA (Lead & Contato)
        let leadId = null;
        if (jid && !jid.includes('@g.us')) {
            // Cria ou Atualiza Lead (Name Update está aqui dentro)
            leadId = await ensureLeadExists(jid, companyId, forcedName);
            
            // Se for realtime, garante que o contato no banco esteja atualizado com o pushName recente
            if (isRealtime && forcedName) {
                await upsertContact(jid, companyId, forcedName, null, false);
            }
        }
        
        // Se for grupo
        if (jid.includes('@g.us') && msg.key.participant && forcedName) {
             const partJid = normalizeJid(msg.key.participant);
             await upsertContact(partJid, companyId, forcedName, null, false);
        }

        // 2. MÍDIA
        let mediaUrl = null;
        if (isMedia) { 
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                let mimeType = 'application/octet-stream';
                if (msg.message?.imageMessage) mimeType = 'image/jpeg';
                else if (msg.message?.videoMessage) mimeType = 'video/mp4';
                else if (msg.message?.audioMessage) mimeType = 'audio/mp4';
                else if (msg.message?.documentMessage) mimeType = msg.message.documentMessage.mimetype;
                else if (msg.message?.stickerMessage) mimeType = 'image/webp';

                mediaUrl = await uploadMedia(buffer, mimeType);
            } catch (e) {}
        }

        // 3. SALVA MENSAGEM
        await upsertMessage({
            company_id: companyId,
            session_id: sessionId,
            remote_jid: jid, // AGORA ESTÁ NORMALIZADO
            whatsapp_id: msg.key.id,
            from_me: fromMe,
            content: body || (mediaUrl ? '[Mídia]' : '[Arquivo]'),
            media_url: mediaUrl,
            message_type: type?.replace('Message', '') || 'text',
            status: fromMe ? 'sent' : 'received',
            lead_id: leadId,
            created_at: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000)
        });

    } catch (e) {}
};
