
import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    updateSyncStatus
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
    
    // Desenrola tipos complexos para chegar no conteúdo real
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

// V6.4: BODY PARSER ROBUSTO (Corrige mensagens "Empty")
const getBody = (msg) => {
    if (!msg) return '';
    
    // Texto Simples
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    
    // Legendas de Mídia
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;

    // Tipos Especiais (Tags Visuais)
    if (msg.imageMessage) return '[Imagem]';
    if (msg.videoMessage) return '[Vídeo]';
    if (msg.stickerMessage) return '[Sticker]';
    if (msg.audioMessage) return '[Áudio]';
    if (msg.pttMessage) return '[Mensagem de Voz]';
    if (msg.documentMessage) return msg.documentMessage.fileName || '[Documento]';
    if (msg.contactMessage) return `[Contato: ${msg.contactMessage.displayName}]`;
    if (msg.locationMessage) return '[Localização]';
    if (msg.pollCreationMessage || msg.pollCreationMessageV3) return (msg.pollCreationMessage?.name || msg.pollCreationMessageV3?.name) || '[Enquete]';
    if (msg.reactionMessage) return ''; // Reações não são mensagens de texto
    if (msg.protocolMessage) return ''; // Syncs técnicos

    return ''; 
};

// Helper seguro para buscar foto de perfil sem crashar
const fetchProfilePicSafe = async (sock, jid) => {
    try {
        return await sock.profilePictureUrl(jid, 'image'); // 'image' = alta resolução, 'preview' = baixa
    } catch (e) {
        return null; // Retorna null se não tiver foto ou privacidade bloquear
    }
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
            console.log(`📚 [HISTÓRICO] Iniciando Sync V6.5 (Media & Profiles)... Sessão: ${sessionId}`);
            await updateSyncStatus(sessionId, 'importing_contacts', 5);

            // 1. MAPA DE NOMES & FOTOS (Name Hunter)
            const contactsMap = new Map();
            const profilePicMap = new Map();
            
            // A. Agenda (Prioridade)
            if (contacts) {
                contacts.forEach(c => {
                    const clean = cleanJid(c.id);
                    const bestName = c.name || c.verifiedName || c.notify || c.short;
                    if (bestName) contactsMap.set(clean, bestName);
                    // Captura foto se vier no payload inicial
                    if (c.imgUrl) profilePicMap.set(clean, c.imgUrl);
                });
            }

            // B. Mensagens (Deep Scavenger)
            if (messages) {
                messages.forEach(msg => {
                    if (!msg.key.fromMe) {
                        const senderJid = cleanJid(msg.key.remoteJid);
                        if (senderJid && msg.pushName && !contactsMap.has(senderJid)) {
                            contactsMap.set(senderJid, msg.pushName);
                        }
                        if (msg.key.participant) {
                            const partJid = cleanJid(msg.key.participant);
                            if (partJid && msg.pushName && !contactsMap.has(partJid)) {
                                contactsMap.set(partJid, msg.pushName);
                            }
                        }
                    }
                });
            }

            // 2. PRE-SEED LEADS & CONTATOS
            await updateSyncStatus(sessionId, 'importing_messages', 20);
            
            const mapEntries = Array.from(contactsMap.entries());
            const BATCH_SIZE = 50;
            
            for (let i = 0; i < mapEntries.length; i += BATCH_SIZE) {
                const batch = mapEntries.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async ([jid, name]) => {
                    const clean = cleanJid(jid);
                    if (!clean) return;

                    // Cria Lead se for chat privado
                    if (clean.includes('@s.whatsapp.net')) {
                        await ensureLeadExists(clean, companyId, name);
                    }

                    // Tenta recuperar foto salva ou usa null (será atualizada se encontrada depois)
                    const picUrl = profilePicMap.get(clean) || null;

                    // Força update do contato na tabela contacts (Agenda)
                    await upsertContact(clean, companyId, name, picUrl, true);
                }));
            }

            // 3. PROCESSAR MENSAGENS (Limite de 10)
            await updateSyncStatus(sessionId, 'processing_history', 40);
            
            const messagesByChat = new Map();
            messages.forEach(msg => {
                const unwrapped = unwrapMessage(msg);
                if(!unwrapped.key?.remoteJid) return;
                
                const jid = cleanJid(unwrapped.key.remoteJid);
                if (jid === 'status@broadcast') return;
                
                if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                messagesByChat.get(jid).push(unwrapped);
            });

            // Ordena chats por atividade recente
            const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
                const tA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
                const tB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
                return tB - tA; 
            });

            // LIMITES AUMENTADOS: 200 Chats, 10 mensagens cada (PEDIDO V6.5)
            const topChats = sortedChats.slice(0, 200); 
            let finalMessages = [];
            topChats.forEach(([_, msgs]) => {
                msgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                // PEGA APENAS AS ÚLTIMAS 10
                finalMessages.push(...msgs.slice(-10)); 
            });

            let processed = 0;
            // Busca fotos de perfil para os Top 20 Chats Ativos (para não estourar rate limit)
            const top20Jids = topChats.slice(0, 20).map(c => c[0]);
            
            for (const chatJid of top20Jids) {
                // Se não temos a foto no mapa inicial, buscamos agora
                if (!profilePicMap.has(chatJid) && chatJid.includes('@s.whatsapp.net')) {
                    const url = await fetchProfilePicSafe(sock, chatJid);
                    if (url) {
                        const name = contactsMap.get(chatJid);
                        await upsertContact(chatJid, companyId, name, url, false);
                    }
                }
            }

            for (const msg of finalMessages) {
                const jidKey = cleanJid(msg.key.remoteJid);
                const senderKey = msg.key.participant ? cleanJid(msg.key.participant) : jidKey;
                const bestName = contactsMap.get(senderKey) || msg.pushName;
                
                await processSingleMessage(msg, sock, companyId, sessionId, false, bestName);
                
                processed++;
                if(processed % 10 === 0) {
                    const pct = 40 + Math.round((processed / finalMessages.length) * 60);
                    await updateSyncStatus(sessionId, 'processing_history', pct);
                }
            }

            await updateSyncStatus(sessionId, 'completed', 100);
            console.log(`✅ [HISTÓRICO] Sync Finalizado. Processadas ${processed} mensagens com Mídia Total.`);

        } catch (e) {
            console.error("History Sync Error:", e);
        } finally {
            setTimeout(() => { isProcessingHistory = false; }, 5000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify' || type === 'append') {
            for (const msg of messages) {
                const clean = unwrapMessage(msg);
                // Realtime: Busca foto se for contato novo
                const jid = cleanJid(clean.key.remoteJid);
                if (jid && !clean.key.fromMe && !clean.key.participant) { // Só busca se for chat direto
                     // Optimistic fetch (não espera)
                     fetchProfilePicSafe(sock, jid).then(url => {
                         if(url) upsertContact(jid, companyId, clean.pushName, url, false);
                     });
                }
                
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

        const body = getBody(msg.message);
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        
        // Se body for vazio E não for mídia, ignora
        if (!body && !isMedia) return;

        const fromMe = msg.key.fromMe;

        // 1. Lead & Contato
        let leadId = null;
        if (jid && !jid.includes('@g.us')) {
            leadId = await ensureLeadExists(jid, companyId, forcedName);
        }
        
        if (jid.includes('@g.us') && msg.key.participant && forcedName) {
             const partJid = cleanJid(msg.key.participant);
             await upsertContact(partJid, companyId, forcedName, null, true);
        }

        // 2. Mídia (AGORA BAIXA SEMPRE - Histórico e Realtime)
        // V6.5: Removemos o 'if (isRealtime)'
        let mediaUrl = null;
        if (isMedia) { 
            try {
                // Download buffer
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                // Define MIME type correto
                let mimeType = 'application/octet-stream';
                if (msg.message?.imageMessage) mimeType = 'image/jpeg';
                else if (msg.message?.videoMessage) mimeType = 'video/mp4';
                else if (msg.message?.audioMessage) mimeType = 'audio/mp4'; // WhatsApp usa m4a/aac que é mp4 container
                else if (msg.message?.documentMessage) mimeType = msg.message.documentMessage.mimetype;
                else if (msg.message?.stickerMessage) mimeType = 'image/webp';

                mediaUrl = await uploadMedia(buffer, mimeType);
            } catch (e) {
                // Falha silenciosa no download de mídia (comum em histórico antigo)
                // console.warn('Falha ao baixar mídia antiga:', e.message);
            }
        }

        // 3. Salva Mensagem
        await upsertMessage({
            company_id: companyId,
            session_id: sessionId,
            remote_jid: jid,
            whatsapp_id: msg.key.id,
            from_me: fromMe,
            content: body || (mediaUrl ? '[Mídia]' : '[Arquivo]'),
            media_url: mediaUrl,
            message_type: type?.replace('Message', '') || 'text',
            status: fromMe ? 'sent' : 'received',
            lead_id: leadId,
            created_at: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000)
        });

    } catch (e) {
        // Silently fail individual messages
    }
};
