import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    updateSyncStatus
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

let isProcessingHistory = false;

// Helpers
const cleanJid = (jid) => {
    if (!jid) return null;
    const temp = jid.split('@')[0].split(':')[0];
    const suffix = jid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net';
    return temp + suffix;
};

const unwrapMessage = (msg) => {
    if (!msg.message) return msg;
    let content = msg.message;
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    if (content.viewOnceMessage) content = content.viewOnceMessage.message;
    if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
    if (content.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;
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
    return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
};

// ==============================================================================
// CONFIGURAÇÃO DOS LISTENERS
// ==============================================================================
export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // --- HISTÓRICO ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        if (isProcessingHistory) return;
        isProcessingHistory = true;

        try {
            console.log(`📚 [HISTÓRICO] Iniciando Sync V6... Sessão: ${sessionId}`);
            await updateSyncStatus(sessionId, 'importing_contacts', 5);

            // 1. MAPA DE NOMES (Name Hunter)
            const contactsMap = new Map();
            
            // A. Agenda
            if (contacts) {
                contacts.forEach(c => {
                    const bestName = c.name || c.verifiedName || c.notify || c.short;
                    if (bestName) contactsMap.set(cleanJid(c.id), bestName);
                });
            }

            // B. Mensagens (Scavenger)
            if (messages) {
                messages.forEach(msg => {
                    if (msg.key.fromMe) return;
                    const jidKey = cleanJid(msg.key.remoteJid);
                    // Só pega o pushName se não tivermos nome da agenda ainda
                    if (jidKey && msg.pushName && !contactsMap.has(jidKey)) {
                        contactsMap.set(jidKey, msg.pushName);
                    }
                });
            }

            // 2. SALVAR CONTATOS PRIORITÁRIOS
            // Isso garante que o contato exista com nome ANTES de processar mensagens
            await updateSyncStatus(sessionId, 'importing_messages', 20);
            
            // Converte o Map para Array para iterar
            const mapEntries = Array.from(contactsMap.entries());
            
            // Processa em lotes para não travar o banco
            const BATCH_SIZE = 50;
            for (let i = 0; i < mapEntries.length; i += BATCH_SIZE) {
                const batch = mapEntries.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async ([jid, name]) => {
                    // Verifica se veio da agenda original
                    const isFromBook = contacts?.some(c => cleanJid(c.id) === jid && c.name);
                    await upsertContact(jid, companyId, name, null, isFromBook);
                }));
            }

            // 3. PROCESSAR MENSAGENS
            await updateSyncStatus(sessionId, 'processing_history', 40);
            
            // Filtra e ordena (Mesma lógica V5)
            const messagesByChat = new Map();
            messages.forEach(msg => {
                const unwrapped = unwrapMessage(msg);
                if(!unwrapped.key?.remoteJid) return;
                const jid = cleanJid(unwrapped.key.remoteJid);
                if (jid === 'status@broadcast') return;
                if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                messagesByChat.get(jid).push(unwrapped);
            });

            const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
                const tA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
                const tB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
                return tB - tA; 
            });

            const topChats = sortedChats.slice(0, 60); // Top 60 chats
            let finalMessages = [];
            topChats.forEach(([_, msgs]) => {
                msgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                finalMessages.push(...msgs.slice(-25)); // Últimas 25
            });

            let processed = 0;
            for (const msg of finalMessages) {
                const jidKey = cleanJid(msg.key.remoteJid);
                // Resgata o nome do mapa para garantir consistência
                const bestName = contactsMap.get(jidKey) || msg.pushName;
                
                await processSingleMessage(msg, sock, companyId, sessionId, false, bestName);
                
                processed++;
                if(processed % 20 === 0) {
                    const pct = 40 + Math.round((processed / finalMessages.length) * 60);
                    await updateSyncStatus(sessionId, 'processing_history', pct);
                }
            }

            await updateSyncStatus(sessionId, 'completed', 100);
            console.log(`✅ [HISTÓRICO] Sync V6 Finalizado. ${processed} mensagens.`);

        } catch (e) {
            console.error(e);
        } finally {
            setTimeout(() => { isProcessingHistory = false; }, 5000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify' || type === 'append') {
            for (const msg of messages) {
                const clean = unwrapMessage(msg);
                // Realtime: Passamos o pushName para tentar corrigir leads sem nome na hora
                await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName);
            }
        }
    });
};

const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null) => {
    try {
        if (!msg.message) return;
        const jid = cleanJid(msg.key.remoteJid);
        if (jid === 'status@broadcast') return;

        const fromMe = msg.key.fromMe;
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        const body = getBody(msg.message);

        // 1. Tenta criar/recuperar Lead
        // Se forcedName vier (do mapa ou pushName), o ensureLeadExists vai tentar corrigir nomes NULL
        let leadId = null;
        if (jid && !jid.includes('@g.us')) {
            leadId = await ensureLeadExists(jid, companyId, forcedName);
        }
        
        // 2. Mídia (Só realtime)
        let mediaUrl = null;
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        if (isMedia && isRealtime) { 
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                let mimeType = 'application/octet-stream';
                // ... lógica simples de mime
                mediaUrl = await uploadMedia(buffer, mimeType);
            } catch (e) {}
        }

        // 3. Salva Mensagem
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
