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

// Safe Profile Pic Fetcher (Com Jitter para evitar Rate Limit)
const fetchProfilePicSafe = async (sock, jid) => {
    try {
        await new Promise(r => setTimeout(r, Math.random() * 200 + 100)); 
        const url = await sock.profilePictureUrl(jid, 'image'); 
        return url;
    } catch (e) {
        return null; 
    }
};

// Novo Helper: Busca nome do grupo se falhar no histórico
const fetchGroupSubjectSafe = async (sock, jid) => {
    try {
        await new Promise(r => setTimeout(r, 300)); // Rate limit para grupos
        const metadata = await sock.groupMetadata(jid);
        return metadata.subject;
    } catch (e) {
        return null;
    }
};

export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // --- HISTÓRICO COMPLETO (BLINDADO) ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages, isLatest }) => {
        // Se já estiver processando, ignora para evitar crash de memória e duplicidade
        if (isProcessingHistory) {
            console.log(`⚠️ [HISTÓRICO] Sync já em andamento para ${sessionId}. Ignorando duplicata.`);
            return;
        }
        
        isProcessingHistory = true;
        console.log(`📚 [HISTÓRICO] Recebido pacote de dados (Latest: ${isLatest}). Iniciando processamento seguro...`);

        try {
            // 1. Feedback Visual Inicial
            await updateSyncStatus(sessionId, 'importing_contacts', 5);

            const contactsMap = new Map();

            // 2. Processamento de Contatos (Com Fallback)
            if (contacts && contacts.length > 0) {
                console.log(`📇 [HISTÓRICO] Mapeando ${contacts.length} contatos...`);
                
                await Promise.all(contacts.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    // Prioridade de Nomes: Nome Salvo > Verified Name > Notify > NULL
                    const bestName = c.name || c.verifiedName || c.notify;
                    
                    contactsMap.set(jid, { 
                        name: bestName, 
                        imgUrl: c.imgUrl, 
                        isFromBook: !!c.name, // Só é "da agenda" se tiver c.name explícito
                        lid: c.lid || null 
                    });
                }));
            }

            // 3. Scan de Mensagens (Enriquecimento de Dados - Name Hunter)
            // Tenta descobrir nomes perdidos olhando os metadados das mensagens
            if (messages && messages.length > 0) {
                messages.forEach(msg => {
                    if (msg.key.fromMe) return;
                    const jid = normalizeJid(msg.key.remoteJid);
                    if (!jid) return;
                    
                    const existing = contactsMap.get(jid);
                    
                    // Se não temos contato, ou o contato não tem nome, pegamos da mensagem (PushName)
                    if (!existing || !existing.name) {
                        const pushName = msg.pushName;
                        if (pushName) {
                            if (existing) {
                                existing.name = pushName; 
                            } else {
                                contactsMap.set(jid, { name: pushName, imgUrl: null, isFromBook: false, lid: null });
                            }
                        }
                    }
                });
            }

            // 4. Salva Contatos (Lote Controlado com UNBLOCK EVENT LOOP)
            const uniqueJids = Array.from(contactsMap.keys());
            const BATCH_SIZE = 10; 
            let processedContacts = 0;
            
            for (let i = 0; i < uniqueJids.length; i += BATCH_SIZE) {
                const batchJids = uniqueJids.slice(i, i + BATCH_SIZE);
                
                await Promise.all(batchJids.map(async (jid) => {
                    let data = contactsMap.get(jid);
                    
                    // GRUPOS SEM NOME: Tenta buscar metadata na API
                    if (jid.includes('@g.us') && !data.name) {
                        const groupName = await fetchGroupSubjectSafe(sock, jid);
                        if (groupName) data.name = groupName;
                    }

                    // FOTOS: Busca se não tiver (Rate Limited)
                    if (!data.imgUrl) {
                        const freshPic = await fetchProfilePicSafe(sock, jid);
                        if (freshPic) data.imgUrl = freshPic;
                    }

                    await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook, data.lid);
                }));

                processedContacts += batchJids.length;
                
                // --- CRÍTICO: UNBLOCK EVENT LOOP ---
                // Pausa de 20ms a cada lote para o Node responder Pings do WebSocket
                // Isso evita o erro 408/Timeout e desconexões em loop
                await new Promise(r => setTimeout(r, 20)); 
                
                const percent = 5 + Math.floor((processedContacts / uniqueJids.length) * 25);
                if (processedContacts % 20 === 0) {
                    await updateSyncStatus(sessionId, 'importing_contacts', percent);
                }
            }

            // 5. Processa Mensagens (Lote Controlado com UNBLOCK)
            if (messages && messages.length > 0) {
                console.log(`💬 [HISTÓRICO] Processando ${messages.length} mensagens...`);
                await updateSyncStatus(sessionId, 'importing_messages', 30);
                
                // Agrupa por chat para processar ordenadamente
                const messagesByChat = new Map();
                messages.forEach(msg => {
                    const unwrapped = unwrapMessage(msg);
                    if(!unwrapped.key?.remoteJid) return;
                    const jid = normalizeJid(unwrapped.key.remoteJid);
                    if (!jid || jid === 'status@broadcast') return;
                    if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                    messagesByChat.get(jid).push(unwrapped);
                });

                // Ordena chats mais recentes primeiro
                const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
                    const tA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
                    const tB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
                    return tB - tA; 
                });

                // Aumentado limite para pegar mais histórico sem travar
                const topChats = sortedChats.slice(0, 200); 
                
                for (let i = 0; i < topChats.length; i++) {
                    const [chatJid, chatMsgs] = topChats[i];
                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    const msgsToSave = chatMsgs.slice(-40); // Últimas 40 por chat

                    for (const msg of msgsToSave) {
                        const mapData = contactsMap.get(chatJid);
                        const forcedName = msg.pushName || (mapData ? mapData.name : null);
                        
                        // Passamos ID do bot para evitar self-lead
                        await processSingleMessage(msg, sock, companyId, sessionId, false, forcedName);
                    }

                    // --- CRÍTICO: UNBLOCK EVENT LOOP ---
                    // Pausa leve a cada chat processado
                    await new Promise(r => setTimeout(r, 5));

                    const percent = 30 + Math.floor((i / topChats.length) * 70);
                    if (i % 5 === 0) {
                        await updateSyncStatus(sessionId, 'importing_messages', percent);
                    }
                }
            }

        } catch (e) {
            console.error("❌ [CRITICAL SYNC ERROR]", e);
            // Em caso de erro, o finally garante o desbloqueio da UI
        } finally {
            // VÁLVULA DE SEGURANÇA: Sempre destrava o frontend com 100%
            console.log(`✅ [SYNC] Finalizando processo para ${sessionId}. Destravando UI.`);
            await updateSyncStatus(sessionId, 'completed', 100);
            isProcessingHistory = false;
        }
    });

    // --- REALTIME MESSAGES ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            if (!addToCache(msg.key.id)) continue;

            const clean = unwrapMessage(msg);
            const jid = normalizeJid(clean.key.remoteJid);
            
            // BUSCA FOTO E NOME REATIVO EM TEMPO REAL
            if (jid && !clean.key.fromMe) { 
                 fetchProfilePicSafe(sock, jid).then(url => {
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
            // Upsert seguro - só atualiza se tiver dados relevantes
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
        // Pega ID do bot para evitar auto-criação de lead (Self-Lead Protection)
        const myJid = normalizeJid(sock.user?.id); 

        // 1. GARANTE ESTRUTURA (Com Proteção Self-Lead)
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

        // 2. MÍDIA (Download e Upload)
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

    } catch (e) {
        console.error("Erro processSingleMessage:", e);
    }
};
