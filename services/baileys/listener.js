
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

// --- TRAVA DE SEGURANÇA (Listener V2) ---
// Evita processamento duplicado do histórico se o evento disparar 2x
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
    
    // --- HISTÓRICO COMPLETO (Fusão V1 + V2) ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        // Trava de segurança
        if (isProcessingHistory) {
            console.warn(`⚠️ [HISTÓRICO] Ignorando duplicação de evento para ${sessionId}.`);
            return;
        }
        isProcessingHistory = true;

        try {
            console.log(`📚 [HISTÓRICO] Iniciando Sync... Sessão: ${sessionId}`);
            await updateSyncStatus(sessionId, 'importing_contacts', 5);

            // --- MAPA DE NOMES (NAME HUNTER V5.0) ---
            // Cria um mapa em memória para resolver nomes antes de salvar
            const contactsMap = new Map();

            // 1. Coleta da Agenda (Prioridade Máxima)
            if (contacts && contacts.length > 0) {
                console.log(`📇 [AGENDA] Processando ${contacts.length} contatos da agenda...`);
                contacts.forEach(c => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    // Tenta todos os campos possíveis
                    const bestName = c.name || c.verifiedName || c.notify;
                    if (bestName) {
                        contactsMap.set(jid, { name: bestName, imgUrl: c.imgUrl, isFromBook: true });
                    }
                });
            }

            // 2. Coleta das Mensagens (Scavenger Hunt)
            // Se não estava na agenda, tenta pegar o PushName das mensagens
            if (messages && messages.length > 0) {
                messages.forEach(msg => {
                    if (msg.key.fromMe) return;
                    const jid = normalizeJid(msg.key.remoteJid);
                    if (!jid) return;

                    if (!contactsMap.has(jid) && msg.pushName) {
                        contactsMap.set(jid, { name: msg.pushName, imgUrl: null, isFromBook: false });
                    }
                });
            }

            // 3. Salva Contatos (Lote) - Agora temos os nomes resolvidos
            const uniqueJids = Array.from(contactsMap.keys());
            const BATCH_SIZE = 50;
            
            for (let i = 0; i < uniqueJids.length; i += BATCH_SIZE) {
                const batchJids = uniqueJids.slice(i, i + BATCH_SIZE);
                await Promise.all(batchJids.map(async (jid) => {
                    const data = contactsMap.get(jid);
                    // Aqui a mágica acontece: Se isFromBook=true, o sync.js vai forçar a atualização do Lead
                    await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook);
                }));
            }

            // 4. Processa Mensagens (Histórico)
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

                // Top 200 conversas, últimas 15 msgs
                const topChats = sortedChats.slice(0, 200); 
                let processed = 0;
                
                for (const [chatJid, chatMsgs] of topChats) {
                    // Busca foto atualizada se não veio no mapa
                    if (!contactsMap.has(chatJid)) {
                        fetchProfilePicSafe(sock, chatJid).then(url => {
                            if (url) upsertContact(chatJid, companyId, null, url, false);
                        });
                    }

                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    const msgsToSave = chatMsgs.slice(-15);

                    for (const msg of msgsToSave) {
                        // Tenta usar o nome do mapa se o pushName da mensagem for nulo
                        const mapData = contactsMap.get(chatJid);
                        const forcedName = msg.pushName || (mapData ? mapData.name : null);
                        
                        await processSingleMessage(msg, sock, companyId, sessionId, false, forcedName);
                    }
                    processed += msgsToSave.length;
                }
                console.log(`✅ [HISTÓRICO] Processadas ${processed} mensagens.`);
            }

            await updateSyncStatus(sessionId, 'completed', 100);

        } catch (e) {
            console.error("History Sync Error:", e);
        } finally {
            // Libera a trava após 15 segundos
            setTimeout(() => { isProcessingHistory = false; }, 15000);
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
            
            // Normaliza JID na entrada
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
    
    // Atualização de Contatos em Tempo Real
    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const c of contacts) {
            const jid = normalizeJid(c.id);
            if (!jid) continue;

            const bestName = c.name || c.verifiedName || c.notify;
            // Se c.name existe, é atualização da agenda -> isFromBook = true
            const isFromBook = !!c.name;
            
            await upsertContact(jid, companyId, bestName, c.imgUrl || null, isFromBook);
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
                // isFromBook = false pois pushName não é autoridade máxima (mas ensureLeadExists trata isso)
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
        if (isMedia && isRealtime) { // Só baixa mídia em realtime para performance
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
