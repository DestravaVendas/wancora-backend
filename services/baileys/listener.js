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

// --- CACHE & STATE ---
const msgCache = new Set();
const presenceCache = new Map(); 

// --- PROGRESSO LINEAR (Memória da Sessão) ---
// Variável global para manter o progresso sempre crescente durante a importação
let globalProgress = 0;

// --- FILA DE PROCESSAMENTO (SERIAL) ---
// Garante que os chunks do histórico sejam processados um por vez
let historyQueue = Promise.resolve();

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

// --- LEGACY FETCH: Recupera foto se não vier no histórico (Robustez) ---
const fetchProfilePicSafe = async (sock, jid) => {
    try {
        // Pequeno delay randômico para evitar rate-limit
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

// ==============================================================================
// SETUP LISTENERS (V7.0 - FULL FEATURE & ROBUST)
// ==============================================================================
export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // -----------------------------------------------------------
    // 0. CONEXÃO
    // -----------------------------------------------------------
    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log(`⚡ [LISTENER] Conexão aberta! Preparando importação.`);
            historyQueue = Promise.resolve();
            globalProgress = 5; 
            await updateSyncStatus(sessionId, 'importing_contacts', 5);
        }
    });

    // -----------------------------------------------------------
    // 1. PRESENÇA (Online/Digitando)
    // -----------------------------------------------------------
    sock.ev.on('presence.update', async (presenceUpdate) => {
        const id = normalizeJid(presenceUpdate.id);
        if (!id) return;

        const now = Date.now();
        const lastUpdate = presenceCache.get(id) || 0;
        if (now - lastUpdate < 10000) return; // Throttling de 10s

        const presences = presenceUpdate.presences;
        if (presences[id]) {
            const lastKnown = presences[id].lastKnownPresence;
            const isOnline = lastKnown === 'composing' || lastKnown === 'recording' || lastKnown === 'available';
            
            presenceCache.set(id, now);

            supabase.from('contacts')
                .update({ is_online: isOnline, last_seen_at: new Date().toISOString() })
                .eq('jid', id)
                .eq('company_id', companyId)
                .then(() => {}); 
        }
    });

    // -----------------------------------------------------------
    // 2. ATUALIZAÇÕES DE MENSAGENS (Enquetes em Tempo Real)
    // -----------------------------------------------------------
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.pollUpdates) {
                const pollCreationKey = update.key;
                if (!pollCreationKey) continue;

                for (const pollUpdate of update.pollUpdates) {
                    const vote = pollUpdate.vote;
                    if (!vote) continue;
                    
                    const voterJid = normalizeJid(pollUpdate.pollUpdateMessageKey?.participant || pollUpdate.pollUpdateMessageKey?.remoteJid);
                    const selectedOptions = vote.selectedOptions || [];
                    
                    // Lógica para salvar votos no banco (JSONB Update)
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
                        // Remove voto anterior do mesmo usuário
                        currentVotes = currentVotes.filter(v => v.voterJid !== voterJid);

                        if (selectedOptions.length > 0) {
                             selectedOptions.forEach(opt => {
                                 const optName = opt.name || 'Desconhecido';
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
    // 3. REAÇÕES (Emojis)
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
                // Remove reação anterior do mesmo usuário
                currentReactions = currentReactions.filter(r => r.actor !== reactorJid);
                // Adiciona nova se não for remoção (text vazio/null remove)
                if (text) {
                    currentReactions.push({ text, actor: reactorJid, ts: Date.now() });
                }
                
                await supabase.from('messages').update({ reactions: currentReactions }).eq('whatsapp_id', key.id).eq('company_id', companyId);
            }
        }
    });

    // -----------------------------------------------------------
    // 4. HISTÓRICO DE MENSAGENS (Fila Serial + Progresso Linear)
    // -----------------------------------------------------------
    sock.ev.on('messaging-history.set', (data) => {
        // Enfileira o processamento deste lote para evitar colisão
        historyQueue = historyQueue.then(async () => {
            const { contacts, messages, isLatest } = data;
            console.log(`📚 [HISTÓRICO] Processando Lote Sequencial... (Último? ${isLatest})`);

            try {
                // A. CONTATOS (Progresso 5% -> 30%)
                if (contacts && contacts.length > 0) {
                    if (globalProgress < 10) globalProgress = 10;
                    await updateSyncStatus(sessionId, 'importing_contacts', globalProgress);
                    
                    const BATCH_SIZE = 20; 
                    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                        const batch = contacts.slice(i, i + BATCH_SIZE);
                        
                        await Promise.all(batch.map(async (c) => {
                            const jid = normalizeJid(c.id);
                            if (!jid) return;
                            
                            const isBook = !!c.name; 
                            let bestName = c.name || c.verifiedName || c.notify || null;
                            let imgUrl = c.imgUrl;

                            // 1. Recupera nome de Grupo
                            if (jid.includes('@g.us') && !bestName) {
                                const groupName = await fetchGroupSubjectSafe(sock, jid);
                                if (groupName) bestName = groupName;
                            }

                            // 2. Busca Foto (Legacy Restore) se vier nulo
                            if (!imgUrl && !jid.includes('@g.us')) {
                                imgUrl = await fetchProfilePicSafe(sock, jid);
                            }
                            
                            await upsertContact(jid, companyId, bestName, imgUrl, isBook, c.lid);
                        }));
                    }

                    globalProgress = Math.min(globalProgress + 10, 30);
                    await updateSyncStatus(sessionId, 'importing_contacts', globalProgress);
                }

                // B. MENSAGENS (Progresso 30% -> 95%)
                if (messages && messages.length > 0) {
                    if (globalProgress < 30) globalProgress = 30;
                    await updateSyncStatus(sessionId, 'importing_messages', globalProgress);

                    // Name Hunter
                    for (const msg of messages) {
                        if (!msg.key.fromMe && msg.pushName) {
                            const jid = normalizeJid(msg.key.remoteJid);
                            if (jid) upsertContact(jid, companyId, msg.pushName, null, false);
                        }
                    }

                    // Processamento Agrupado
                    const messagesByChat = new Map();
                    messages.forEach(msg => {
                        const unwrapped = unwrapMessage(msg);
                        if(!unwrapped.key?.remoteJid) return;
                        const jid = normalizeJid(unwrapped.key.remoteJid);
                        if (!jid || jid === 'status@broadcast') return;
                        if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                        messagesByChat.get(jid).push(unwrapped);
                    });

                    const chats = Array.from(messagesByChat.entries());
                    for (const [chatJid, chatMsgs] of chats) {
                        // Ordena e pega últimas 20 para performance
                        chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                        const msgsToSave = chatMsgs.slice(-20); 

                        for (const msg of msgsToSave) {
                            await processSingleMessage(msg, sock, companyId, sessionId, false, msg.pushName, true);
                        }
                    }

                    if (!isLatest) {
                        globalProgress = Math.min(globalProgress + 5, 95);
                        await updateSyncStatus(sessionId, 'importing_messages', globalProgress);
                    }
                }

                // C. FINALIZAÇÃO
                if (isLatest) {
                    console.log(`✅ [HISTÓRICO] Sincronização Totalmente Finalizada.`);
                    globalProgress = 100;
                    await new Promise(r => setTimeout(r, 800));
                    await updateSyncStatus(sessionId, 'completed', 100);
                }

            } catch (e) {
                console.error("❌ [SYNC ERROR]", e);
            }
        });
    });

    // -----------------------------------------------------------
    // 5. MENSAGENS EM TEMPO REAL (Mídia + Revoke)
    // -----------------------------------------------------------
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            const protocolMsg = msg.message?.protocolMessage;
            if (protocolMsg && protocolMsg.type === 0) {
                // Tratamento de Revoke (Mensagem Apagada)
                const keyToRevoke = protocolMsg.key;
                if (keyToRevoke && keyToRevoke.id) {
                    await supabase.from('messages')
                        .update({ content: '⊘ Mensagem apagada', message_type: 'text', is_deleted: true })
                        .eq('whatsapp_id', keyToRevoke.id)
                        .eq('company_id', companyId);
                }
                continue; 
            }

            if (!msg.message) continue;
            if (!addToCache(msg.key.id)) continue; 

            const clean = unwrapMessage(msg);
            const jid = normalizeJid(clean.key.remoteJid);
            
            // Name Hunter & Pic Fetcher Realtime
            if (jid && !clean.key.fromMe) { 
                 fetchProfilePicSafe(sock, jid).then(url => {
                     // Atualiza contato com foto nova se encontrar
                     if(url) upsertContact(jid, companyId, clean.pushName, url, false);
                 });
            }
            
            await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName, true);
        }
    });
    
    // -----------------------------------------------------------
    // 6. ATUALIZAÇÕES DE CONTATO (WEBHOOK)
    // -----------------------------------------------------------
    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const c of contacts) {
            const jid = normalizeJid(c.id);
            if (!jid) continue;
            
            let pic = c.imgUrl;
            // Se veio sem foto, busca na raça
            if (!pic) pic = await fetchProfilePicSafe(sock, jid);
            
            await upsertContact(jid, companyId, c.name || c.notify || c.verifiedName, pic, !!c.name, c.lid);
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
    
    // -----------------------------------------------------------
    // 7. STATUS DE LEITURA (Ticks)
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

            let query = supabase.from('messages').update(updates).eq('whatsapp_id', event.key.id).eq('company_id', companyId);
            if (dbStatus === 'delivered') query = query.neq('status', 'read').neq('status', 'played');
            await query;
        }
    });
};

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

        // Cria Lead
        let shouldCreateLead = createLead;
        if (jid.includes('@g.us') || jid === myJid) {
            shouldCreateLead = false;
        }

        let leadId = null;
        if (shouldCreateLead) {
            leadId = await ensureLeadExists(jid, companyId, forcedName, myJid);
            
            // Se for realtime e temos um nome, garante update do contato
            if (isRealtime && forcedName && jid !== myJid) {
                await upsertContact(jid, companyId, forcedName, null, false);
            }
        }
        
        // Membros de grupo mandando msg
        if (jid.includes('@g.us') && msg.key.participant && forcedName) {
             const partJid = normalizeJid(msg.key.participant);
             if (partJid !== myJid) {
                 await upsertContact(partJid, companyId, forcedName, null, false);
             }
        }

        // Mídia
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
        
        // Parse de Enquete
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
