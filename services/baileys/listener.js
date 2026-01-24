
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

// Utilitário para desenrolar mensagens complexas (ViewOnce, Ephemeral, Edited)
const unwrapMessage = (msg) => {
    if (!msg.message) return msg;
    let content = msg.message;
    
    // Desenrola camadas de proteção do WhatsApp
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    if (content.viewOnceMessage) content = content.viewOnceMessage.message;
    if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
    if (content.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;
    
    // Tratamento de Edição: Pega a mensagem nova
    if (content.editedMessage) {
        content = content.editedMessage.message?.protocolMessage?.editedMessage || content.editedMessage.message;
    }
    
    return { ...msg, message: content };
};

// Upload de Mídia (Core Feature)
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

// Extração de Texto Robusta
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

// Helpers de Contato
const fetchProfilePicSafe = async (sock, jid) => {
    try {
        // Delay aleatório para evitar Rate Limit ao baixar muitas fotos
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

export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    let historyChunkCounter = 0;

    // -----------------------------------------------------------
    // 1. PRESENÇA (ONLINE / LAST SEEN)
    // -----------------------------------------------------------
    sock.ev.on('presence.update', async (presenceUpdate) => {
        const id = presenceUpdate.id;
        const presences = presenceUpdate.presences;
        
        if (presences[id]) {
            const lastKnown = presences[id].lastKnownPresence;
            const isOnline = lastKnown === 'composing' || lastKnown === 'recording' || lastKnown === 'available';
            
            // Atualiza DB sem bloquear
            supabase.from('contacts')
                .update({ 
                    is_online: isOnline,
                    last_seen_at: new Date().toISOString()
                })
                .eq('jid', normalizeJid(id))
                .eq('company_id', companyId)
                .then(({ error }) => { if(error) console.error("Erro presence:", error); });
        }
    });

    // -----------------------------------------------------------
    // 2. ATUALIZAÇÕES (POLLS)
    // -----------------------------------------------------------
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            // Tratamento de Votos em Enquete
            if (update.pollUpdates) {
                const pollCreationKey = update.key;
                if (!pollCreationKey) continue;

                for (const pollUpdate of update.pollUpdates) {
                    const vote = pollUpdate.vote;
                    if (!vote) continue;
                    
                    const voterJid = normalizeJid(pollUpdate.pollUpdateMessageKey?.participant || pollUpdate.pollUpdateMessageKey?.remoteJid);
                    const selectedOptions = vote.selectedOptions || [];
                    
                    // Recupera mensagem original para contexto
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
                        // Remove voto anterior desse usuário
                        currentVotes = currentVotes.filter(v => v.voterJid !== voterJid);

                        if (selectedOptions.length > 0) {
                             selectedOptions.forEach(opt => {
                                 // Tenta achar index pelo nome (Baileys v6+)
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
    // 3. HISTÓRICO DE MENSAGENS (FAST SYNC) - [CORE FEATURE]
    // -----------------------------------------------------------
    sock.ev.on('messaging-history.set', async ({ contacts, messages, isLatest }) => {
        
        // --- TRAVA DE SEGURANÇA: RECONEXÃO ---
        // Verifica se esta sessão já foi totalmente sincronizada antes.
        // Se sim, pulamos o processamento pesado para evitar ETIMEDOUT e duplicação.
        const { data: currentInstance } = await supabase
            .from('instances')
            .select('sync_status')
            .eq('session_id', sessionId)
            .eq('company_id', companyId)
            .single();

        if (currentInstance?.sync_status === 'completed') {
            console.log(`⏩ [HISTÓRICO] Ignorando sincronização: Instância ${sessionId} já está 'completed'.`);
            return;
        }
        // ---------------------------------------

        historyChunkCounter++;
        const itemCount = (contacts?.length || 0) + (messages?.length || 0);
        console.log(`📚 [HISTÓRICO] Lote ${historyChunkCounter} | Itens: ${itemCount} | isLatest: ${isLatest}`);

        // Se o chunk vier vazio, finaliza se for o último
        if (itemCount === 0) {
            if (isLatest) await updateSyncStatus(sessionId, 'completed', 100);
            return;
        }

        try {
            const contactsMap = new Map();

            // A. Processamento de Contatos (Batch)
            if (contacts && contacts.length > 0) {
                await updateSyncStatus(sessionId, 'importing_contacts', 10);
                
                // Mapeia primeiro
                contacts.forEach(c => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    contactsMap.set(jid, { 
                        name: c.name || c.verifiedName || c.notify, 
                        imgUrl: c.imgUrl, 
                        isFromBook: !!c.name,
                        lid: c.lid || null 
                    });
                });

                // Executa Upsert em Lotes menores para aliviar o banco
                const uniqueJids = Array.from(contactsMap.keys());
                const BATCH_SIZE = 10; // Reduzido de 20 para 10 para evitar timeouts
                
                for (let i = 0; i < uniqueJids.length; i += BATCH_SIZE) {
                    const batchJids = uniqueJids.slice(i, i + BATCH_SIZE);
                    await Promise.all(batchJids.map(async (jid) => {
                        let data = contactsMap.get(jid);
                        
                        // Tenta enriquecer Grupos sem nome
                        if (jid.includes('@g.us') && !data.name) {
                            const groupName = await fetchGroupSubjectSafe(sock, jid);
                            if (groupName) data.name = groupName;
                        }
                        
                        // Tenta foto se não tiver (bem leve)
                        if (!data.imgUrl) {
                            const freshPic = await fetchProfilePicSafe(sock, jid);
                            if (freshPic) data.imgUrl = freshPic;
                        }
                        
                        await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook, data.lid);
                    }));
                    
                    // FIX: Pausa de 100ms a cada lote de contatos. 
                    // Vital para evitar ETIMEDOUT no Redis/DB.
                    await new Promise(r => setTimeout(r, 100)); 
                }
            }

            // B. Name Hunter em Mensagens (Extrai nomes de quem não está na agenda)
            if (messages && messages.length > 0) {
                messages.forEach(msg => {
                    if (msg.key.fromMe) return;
                    const jid = normalizeJid(msg.key.remoteJid);
                    if (!jid) return;
                    
                    const existing = contactsMap.get(jid);
                    if ((!existing || !existing.name) && msg.pushName) {
                        if (existing) existing.name = msg.pushName; 
                        else contactsMap.set(jid, { name: msg.pushName, imgUrl: null, isFromBook: false, lid: null });
                        
                        upsertContact(jid, companyId, msg.pushName, null, false);
                    }
                });
            }

            // C. Processamento de Mensagens
            if (messages && messages.length > 0) {
                await updateSyncStatus(sessionId, 'importing_messages', 30);
                
                // Agrupa mensagens por Chat para processar ordenado
                const messagesByChat = new Map();
                messages.forEach(msg => {
                    const unwrapped = unwrapMessage(msg);
                    if(!unwrapped.key?.remoteJid) return;
                    const jid = normalizeJid(unwrapped.key.remoteJid);
                    if (!jid || jid === 'status@broadcast') return;
                    
                    if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                    messagesByChat.get(jid).push(unwrapped);
                });

                // Ordena chats pelos mais recentes primeiro
                const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
                    const tA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
                    const tB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
                    return tB - tA; 
                });

                // PROCESSA TODOS OS CHATS (Sem limite de 300)
                const topChats = sortedChats; 
                
                for (let i = 0; i < topChats.length; i++) {
                    const [chatJid, chatMsgs] = topChats[i];
                    // Ordena mensagens cronologicamente (antiga -> nova)
                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    
                    // Salva apenas as últimas 10 mensagens de cada chat (Solicitado pelo usuário)
                    const msgsToSave = chatMsgs.slice(-10); 

                    for (const msg of msgsToSave) {
                        const mapData = contactsMap.get(chatJid);
                        const forcedName = msg.pushName || (mapData ? mapData.name : null);
                        
                        // isRealtime = false (Não baixa mídia pesada no histórico para ser rápido)
                        await processSingleMessage(msg, sock, companyId, sessionId, false, forcedName);
                    }
                    
                    // FIX: Delay tático agressivo para evitar starvation do Event Loop
                    // Pausa 200ms a cada 5 chats processados.
                    if (i % 5 === 0) await new Promise(r => setTimeout(r, 200));
                    else await new Promise(r => setTimeout(r, 10));

                    // Atualiza progresso visualmente a cada 20 chats
                    if (i % 20 === 0) {
                        const progress = 30 + Math.floor((i / topChats.length) * 65);
                        await updateSyncStatus(sessionId, 'importing_messages', progress);
                    }
                }
            }

        } catch (e) {
            console.error("❌ [SYNC ERROR]", e);
        } finally {
            // Se for o último chunk (isLatest), finaliza e marca como completed.
            if (isLatest) {
                await updateSyncStatus(sessionId, 'completed', 100);
                console.log(`✅ [HISTÓRICO] Sincronização Total Concluída.`);
            } else {
                await updateSyncStatus(sessionId, 'importing_messages', 99);
                console.log(`⏳ [HISTÓRICO] Chunk finalizado, aguardando próximo...`);
            }
        }
    });

    // -----------------------------------------------------------
    // 4. MENSAGENS EM TEMPO REAL (UPSERT)
    // -----------------------------------------------------------
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            // 4.1 REVOKE
            const protocolMsg = msg.message?.protocolMessage;
            if (protocolMsg && protocolMsg.type === 0) {
                const keyToRevoke = protocolMsg.key;
                if (keyToRevoke && keyToRevoke.id) {
                    console.log(`🗑️ [REVOKE] Mensagem apagada: ${keyToRevoke.id}`);
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
            
            if (jid && !clean.key.fromMe) { 
                 fetchProfilePicSafe(sock, jid).then(url => {
                     if(url) upsertContact(jid, companyId, clean.pushName, url, false);
                 });
            }
            
            await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName);
        }
    });
    
    // -----------------------------------------------------------
    // 5. STATUS DE LEITURA (TICKS)
    // -----------------------------------------------------------
    sock.ev.on('message-receipt.update', async (events) => {
        for (const event of events) {
            const statusMap = {
                1: 'sent',       // 1 Check Cinza
                2: 'delivered',  // 2 Checks Cinza
                3: 'read',       // Azul
                4: 'played'      // Azul (Áudio Ouvido)
            };
            const newStatus = statusMap[event.receipt.userJid ? 0 : event.receipt.status] || statusMap[event.receipt.status];

            if (!newStatus) continue;

            const updates = { status: newStatus };
            if (newStatus === 'delivered') updates.delivered_at = new Date();
            if (newStatus === 'read' || newStatus === 'played') updates.read_at = new Date();

            await supabase.from('messages')
                .update(updates)
                .eq('whatsapp_id', event.key.id)
                .eq('company_id', companyId);
        }
    });

    // -----------------------------------------------------------
    // 6. REAÇÕES (EMOJIS)
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
                currentReactions = currentReactions.filter(r => r.actor !== reactorJid);
                if (text) {
                    currentReactions.push({ text, actor: reactorJid, ts: Date.now() });
                }
                
                await supabase
                    .from('messages')
                    .update({ reactions: currentReactions })
                    .eq('whatsapp_id', key.id)
                    .eq('company_id', companyId);
            }
        }
    });

    // -----------------------------------------------------------
    // 7. EVENTOS DE CONTATO (SYNC)
    // -----------------------------------------------------------
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

// -----------------------------------------------------------
// PROCESSADOR CENTRAL DE MENSAGENS
// -----------------------------------------------------------
const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null) => {
    try {
        if (!msg.message) return;
        const jid = normalizeJid(msg.key.remoteJid);
        if (jid === 'status@broadcast') return;

        // 1. Extração de Conteúdo
        const body = getBody(msg.message);
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        
        if (!body && !isMedia && type !== 'pollCreationMessageV3') return;

        const fromMe = msg.key.fromMe;
        const myJid = normalizeJid(sock.user?.id); 

        // 2. Garantia de Lead (Anti-Ghost)
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

        // 3. Processamento de Mídia
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

        // 4. Detecção de PTT
        let messageTypeClean = type?.replace('Message', '') || 'text';
        if (type === 'audioMessage' && msg.message.audioMessage.ptt) {
            messageTypeClean = 'ptt'; 
        }
        if (type === 'pollCreationMessageV3' || type === 'pollCreationMessage') {
            messageTypeClean = 'poll';
        }

        // 5. Tratamento do Conteúdo
        let finalContent = body || (mediaUrl ? '[Mídia]' : '');
        
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

        // 6. Persistência
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
