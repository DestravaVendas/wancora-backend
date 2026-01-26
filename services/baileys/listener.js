import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    updateSyncStatus,
    normalizeJid
} from '../crm/sync.js';
import {
    downloadMediaMessage,
    getContentType,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: {
        persistSession: false // Importante para Backend
    }
});

const logger = pino({ level: 'silent' });

// Cache de deduplicação em memória (curta duração)
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

// Jitter para evitar Rate Limit ao baixar fotos
const fetchProfilePicSafe = async (sock, jid) => {
    try {
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
    
    // --- 1. PRESENÇA (ONLINE / DIGITANDO) ---
    sock.ev.on('presence.update', async ({ id, presences }) => {
        try {
            const jid = normalizeJid(id);
            if (!jid || jid.includes('@g.us')) return; 

            const participant = Object.values(presences)[0]; 
            if (!participant) return;

            // Define se está online baseado no status do protocolo
            const isOnline = participant.lastKnownPresence === 'available' || 
                             participant.lastKnownPresence === 'composing' || 
                             participant.lastKnownPresence === 'recording';
            
            // Atualiza tabela contacts (Fire and Forget)
            supabase.from('contacts')
                .update({ 
                    is_online: isOnline,
                    last_seen_at: new Date().toISOString()
                })
                .eq('jid', jid)
                .eq('company_id', companyId)
                .then(); // .then() vazio para não bloquear a thread
        } catch (e) {}
    });

    // --- 2. HISTÓRICO DE MENSAGENS (SINGLE PASS MODE) ---
    // Alterado para processar tudo de uma vez, garantindo ordem: Contatos -> Mensagens
    sock.ev.on('messaging-history.set', async ({ contacts, messages, isLatest }) => {
        const msgCount = messages?.length || 0;
        const contactCount = contacts?.length || 0;
        
        console.log(`📚 [HISTÓRICO] Recebido: ${contactCount} contatos, ${msgCount} mensagens. Processando...`);

        try {
            await updateSyncStatus(sessionId, 'importing_contacts', 10);

            // 1. MAPA DE CONTATOS (Prioridade Absoluta)
            // Processamos todos os contatos PRIMEIRO para garantir que o 'ensureLeadExists' encontre nomes.
            const contactsMap = new Map();
            
            if (contacts && contacts.length > 0) {
                // Prepara mapa local
                contacts.forEach(c => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    const bestName = c.name || c.verifiedName || c.notify;
                    contactsMap.set(jid, { 
                        name: bestName, 
                        imgUrl: c.imgUrl, 
                        isFromBook: !!c.name, // Se tem 'name', veio da agenda do celular
                        lid: c.lid || null 
                    });
                });

                // Upsert em Lote Controlado (Para não estourar conexões do banco)
                const uniqueJids = Array.from(contactsMap.keys());
                const BATCH_SIZE = 50; 
                
                for (let i = 0; i < uniqueJids.length; i += BATCH_SIZE) {
                    const batchJids = uniqueJids.slice(i, i + BATCH_SIZE);
                    await Promise.all(batchJids.map(async (jid) => {
                        let data = contactsMap.get(jid);
                        
                        // Enriquecimento de Dados (Grupos e Fotos)
                        if (jid.includes('@g.us') && !data.name) {
                            const groupName = await fetchGroupSubjectSafe(sock, jid);
                            if (groupName) data.name = groupName;
                        }
                        // Opcional: Baixar foto se não tiver (pode demorar, então talvez pular no histórico massivo)
                        // if (!data.imgUrl) data.imgUrl = await fetchProfilePicSafe(sock, jid);

                        await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook, data.lid);
                    }));
                }
            }

            // 2. PROCESSAMENTO DE MENSAGENS
            if (messages && messages.length > 0) {
                await updateSyncStatus(sessionId, 'importing_messages', 40);

                // Organiza mensagens por chat para processar as mais recentes de cada conversa
                const messagesByChat = new Map();
                messages.forEach(msg => {
                    const unwrapped = unwrapMessage(msg);
                    if(!unwrapped.key?.remoteJid) return;
                    const jid = normalizeJid(unwrapped.key.remoteJid);
                    if (!jid || jid === 'status@broadcast') return;
                    
                    if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                    messagesByChat.get(jid).push(unwrapped);
                });

                // Ordena chats por atividade recente
                const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
                    const tA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
                    const tB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
                    return tB - tA; 
                });

                // Limita a quantidade de chats históricos processados para performance (Top 300 chats)
                const topChats = sortedChats.slice(0, 300);
                
                for (let i = 0; i < topChats.length; i++) {
                    const [chatJid, chatMsgs] = topChats[i];
                    
                    // Ordena cronologicamente
                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    
                    // Pega apenas as últimas 10 mensagens (conforme sua regra de negócio)
                    const msgsToSave = chatMsgs.slice(-10); 

                    for (const msg of msgsToSave) {
                        const mapData = contactsMap.get(chatJid);
                        
                        // Tenta pegar o nome do pushName da mensagem se não tivermos no mapa
                        const senderName = msg.pushName || (mapData ? mapData.name : null);
                        
                        // Salva mensagem (e cria Lead se necessário, agora com nome correto!)
                        await processSingleMessage(msg, sock, companyId, sessionId, false, senderName, true);
                    }

                    // Yield para não travar o event loop
                    if (i % 5 === 0) await new Promise(r => setTimeout(r, 10));

                    // Atualiza progresso visual
                    if (i % 20 === 0) {
                        const progress = 40 + Math.floor((i / topChats.length) * 60);
                        await updateSyncStatus(sessionId, 'importing_messages', progress);
                    }
                }
            }

            console.log("✅ [HISTÓRICO] Sincronização finalizada.");
            await updateSyncStatus(sessionId, 'completed', 100);

        } catch (e) {
            console.error("❌ [SYNC ERROR]", e);
            // Em caso de erro, força status completed para liberar a UI
            await updateSyncStatus(sessionId, 'completed', 100);
        }
    });

    // --- 3. MENSAGENS EM TEMPO REAL ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            const protocolMsg = msg.message?.protocolMessage;
            
            // Revoke (Mensagem Apagada)
            if (protocolMsg && protocolMsg.type === 0) {
                const keyToRevoke = protocolMsg.key;
                if (keyToRevoke?.id) {
                    await supabase.from('messages')
                        .update({ content: '🚫 Mensagem apagada', is_deleted: true })
                        .eq('whatsapp_id', keyToRevoke.id).eq('company_id', companyId);
                }
                continue; 
            }

            if (!msg.message) continue;
            if (!addToCache(msg.key.id)) continue; // Deduplicação

            const clean = unwrapMessage(msg);
            const jid = normalizeJid(clean.key.remoteJid);
            
            // Atualização de Perfil em tempo real (Lazy Update)
            if (jid && !clean.key.fromMe) { 
                 // Não esperamos a foto baixar para processar a mensagem
                 fetchProfilePicSafe(sock, jid).then(url => {
                     if(url) upsertContact(jid, companyId, clean.pushName, url, false);
                 });
            }
            
            await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName, false);
        }
    });

    // --- 4. VOTOS DE ENQUETE ---
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.pollUpdates) {
                for (const pollUpdate of update.pollUpdates) {
                    const messageId = update.key.id;
                    const voterJid = normalizeJid(pollUpdate.senderTimestampMs ? update.key.remoteJid : undefined); // Quem votou? (em grupos, é diferente do remoteJid)
                    
                    // Baileys envia o voto descriptografado em pollUpdate.vote
                    if (pollUpdate.vote) {
                        try {
                            const { data: currentMsg } = await supabase
                                .from('messages')
                                .select('poll_votes')
                                .eq('whatsapp_id', messageId)
                                .eq('company_id', companyId)
                                .single();
                                
                            if (currentMsg) {
                                let votes = Array.isArray(currentMsg.poll_votes) ? currentMsg.poll_votes : [];
                                
                                // Adiciona o voto
                                votes.push({
                                    voterJid,
                                    ts: Date.now(),
                                    selectedOptions: pollUpdate.vote.selectedOptions // Array de hashes/textos
                                });

                                await supabase.from('messages')
                                    .update({ poll_votes: votes, updated_at: new Date() }) 
                                    .eq('whatsapp_id', messageId)
                                    .eq('company_id', companyId);
                            }
                        } catch(err) {
                            console.error("Erro processar voto:", err);
                        }
                    }
                }
            }
        }
    });
    
    // --- 5. STATUS DE LEITURA ---
    sock.ev.on('message-receipt.update', async (events) => {
        for (const event of events) {
            const statusMap = { 
                1: 'sent', 2: 'delivered', 3: 'read', 4: 'played',
                13: 'read' // Novo código do Baileys para Read
            };
            const newStatus = statusMap[event.receipt.status];

            if (newStatus) {
                const updates = { status: newStatus };
                if (newStatus === 'delivered') updates.delivered_at = new Date();
                if (newStatus === 'read') updates.read_at = new Date();

                await supabase.from('messages')
                    .update(updates)
                    .eq('whatsapp_id', event.key.id)
                    .eq('company_id', companyId);
            }
        }
    });

    // --- 6. REAÇÕES ---
    sock.ev.on('messages.reaction', async (reactions) => {
        for (const reaction of reactions) {
            const { key, text } = reaction;
            if (!key.id) continue;

            const myJid = normalizeJid(sock.user?.id);
            const reactorJid = normalizeJid(reaction.key.participant || reaction.key.remoteJid || myJid);

            const { data: msg } = await supabase.from('messages').select('reactions').eq('whatsapp_id', key.id).eq('company_id', companyId).single();

            if (msg) {
                let currentReactions = Array.isArray(msg.reactions) ? msg.reactions : [];
                // Remove reação anterior deste usuário
                currentReactions = currentReactions.filter(r => r.actor !== reactorJid);
                // Adiciona nova se houver texto (se for null, é remoção)
                if (text) currentReactions.push({ text, actor: reactorJid, ts: Date.now() });
                
                await supabase.from('messages').update({ reactions: currentReactions }).eq('whatsapp_id', key.id).eq('company_id', companyId);
            }
        }
    });
};

const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null, ignoreConflict = false) => {
    try {
        if (!msg.message) return;
        const jid = normalizeJid(msg.key.remoteJid);
        const body = getBody(msg.message);
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        
        // Ignora mensagens vazias ou de protocolo puro (exceto mídia)
        if (!body && !['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3'].includes(type)) return;

        let leadId = null;
        if (jid && !jid.includes('@g.us')) {
            // Cria Lead e garante nome correto
            leadId = await ensureLeadExists(jid, companyId, forcedName, normalizeJid(sock.user?.id));
            
            // Se for realtime e tivermos um nome novo (PushName), atualiza o contato
            if (isRealtime && forcedName && jid !== normalizeJid(sock.user?.id)) {
                await upsertContact(jid, companyId, forcedName, null, false);
            }
        }

        let mediaUrl = null;
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        
        if (isMedia && isRealtime) {
            try {
                // Download apenas se for realtime. Histórico não baixa mídia para economizar espaço/banda.
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                
                let mimeType = 'application/octet-stream';
                if(msg.message.imageMessage) mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
                else if(msg.message.audioMessage) mimeType = msg.message.audioMessage.mimetype || 'audio/mp4';
                
                mediaUrl = await uploadMedia(buffer, mimeType);
            } catch (e) { console.error("Media DL Error", e); }
        }

        // Mapeamento de Tipos
        let finalType = 'text';
        if (type.includes('image')) finalType = 'image';
        else if (type.includes('video')) finalType = 'video';
        else if (type.includes('audio')) finalType = 'audio';
        else if (type.includes('document')) finalType = 'document';
        else if (type.includes('poll')) finalType = 'poll';
        else if (type.includes('sticker')) finalType = 'sticker';

        // Salva conteúdo da enquete corretamente
        let finalContent = body || (mediaUrl ? '[Mídia]' : '');
        if (finalType === 'poll') {
            const pollData = msg.message[type];
            finalContent = JSON.stringify({
                name: pollData.name,
                options: pollData.options.map(o => o.optionName),
                selectableOptionsCount: pollData.selectableOptionsCount
            });
        }

        await upsertMessage({
            company_id: companyId,
            session_id: sessionId,
            remote_jid: jid,
            whatsapp_id: msg.key.id,
            from_me: msg.key.fromMe,
            content: finalContent,
            media_url: mediaUrl,
            message_type: finalType,
            status: msg.key.fromMe ? 'sent' : 'received',
            lead_id: leadId,
            created_at: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000)
        }, ignoreConflict);

    } catch (e) {}
};
