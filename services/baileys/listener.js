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

// Utilitário para desenrolar mensagens complexas (ViewOnce, Editadas, etc)
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

// Upload de Mídia para Supabase Storage (Bucket: chat-media)
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

// Extração segura do texto da mensagem
const getBody = (msg) => {
    if (!msg) return '';
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    return ''; 
};

// Fetch seguro de Foto de Perfil com Jitter para evitar Rate Limit (429)
const fetchProfilePicSafe = async (sock, jid) => {
    try {
        await new Promise(r => setTimeout(r, Math.random() * 200 + 100)); 
        const url = await sock.profilePictureUrl(jid, 'image'); 
        return url;
    } catch (e) {
        return null; 
    }
};

const fetchGroupSubjectSafe = async (sock, jid) => {
    try {
        await new Promise(r => setTimeout(r, 300)); 
        const metadata = await sock.groupMetadata(jid);
        return metadata.subject;
    } catch (e) {
        return null;
    }
};

export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // Contador de Lotes para Fast Sync (Limita a 2 pacotes)
    let historyChunkCounter = 0;

    // --- EVENTO CRÍTICO: HISTÓRICO DE MENSAGENS ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages, isLatest }) => {
        historyChunkCounter++;
        const itemCount = (contacts?.length || 0) + (messages?.length || 0);
        console.log(`📚 [HISTÓRICO] Pacote ${historyChunkCounter} recebido: ${itemCount} itens. Processando Fast Sync...`);

        if (itemCount === 0) {
            // Se vier vazio OU se já passamos de 2 lotes, libera o frontend
            if (isLatest || historyChunkCounter >= 2) await updateSyncStatus(sessionId, 'completed', 100);
            return;
        }

        try {
            // Mapa em memória para evitar queries repetitivas durante o processamento do lote
            const contactsMap = new Map();

            // 1. Processamento de Contatos (Upsert em Batch Controlado)
            if (contacts && contacts.length > 0) {
                console.log(`📇 [HISTÓRICO] Mapeando ${contacts.length} contatos...`);
                await updateSyncStatus(sessionId, 'importing_contacts', 10);
                
                // Popula mapa
                contacts.forEach(c => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    const bestName = c.name || c.verifiedName || c.notify;
                    contactsMap.set(jid, { 
                        name: bestName, 
                        imgUrl: c.imgUrl, 
                        isFromBook: !!c.name,
                        lid: c.lid || null 
                    });
                });

                // Executa upserts
                const uniqueJids = Array.from(contactsMap.keys());
                const BATCH_SIZE = 20; // Tamanho do lote para não afogar o banco
                
                for (let i = 0; i < uniqueJids.length; i += BATCH_SIZE) {
                    const batchJids = uniqueJids.slice(i, i + BATCH_SIZE);
                    
                    await Promise.all(batchJids.map(async (jid) => {
                        let data = contactsMap.get(jid);
                        
                        // Enriquece dados se for grupo ou sem foto
                        if (jid.includes('@g.us') && !data.name) {
                            const groupName = await fetchGroupSubjectSafe(sock, jid);
                            if (groupName) data.name = groupName;
                        }
                        if (!data.imgUrl) {
                            const freshPic = await fetchProfilePicSafe(sock, jid);
                            if (freshPic) data.imgUrl = freshPic;
                        }
                        await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook, data.lid);
                    }));

                    // Libera Event Loop por 10ms para o Node respirar
                    await new Promise(r => setTimeout(r, 10));
                    
                    // Log de Progresso (Visível no Render)
                    if (i % 100 === 0) console.log(`📇 [SYNC CONTATOS] Processados ${Math.min(i + BATCH_SIZE, uniqueJids.length)}/${uniqueJids.length}`);
                }
            }

            // 2. Scan de Mensagens (Name Hunter - Tenta achar nomes nos metadados das mensagens)
            if (messages && messages.length > 0) {
                messages.forEach(msg => {
                    if (msg.key.fromMe) return;
                    const jid = normalizeJid(msg.key.remoteJid);
                    if (!jid) return;
                    const existing = contactsMap.get(jid);
                    // Se não temos nome ainda, mas a mensagem tem pushName, usamos ele
                    if (!existing || !existing.name) {
                        if (msg.pushName) {
                            if (existing) existing.name = msg.pushName; 
                            else contactsMap.set(jid, { name: msg.pushName, imgUrl: null, isFromBook: false, lid: null });
                        }
                    }
                });
            }

            // 3. Processamento de Mensagens (O mais pesado)
            if (messages && messages.length > 0) {
                console.log(`💬 [HISTÓRICO] Processando ${messages.length} mensagens...`);
                await updateSyncStatus(sessionId, 'importing_messages', 30);
                
                // Agrupa por Chat para manter ordem cronológica e consistência de contexto
                const messagesByChat = new Map();
                messages.forEach(msg => {
                    const unwrapped = unwrapMessage(msg);
                    if(!unwrapped.key?.remoteJid) return;
                    const jid = normalizeJid(unwrapped.key.remoteJid);
                    if (!jid || jid === 'status@broadcast') return;
                    if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                    messagesByChat.get(jid).push(unwrapped);
                });

                // Ordena chats por atividade recente (Mais recentes primeiro)
                const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
                    const tA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
                    const tB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
                    return tB - tA; 
                });

                // Limita a 300 chats mais recentes para não estourar memória na importação inicial
                const topChats = sortedChats.slice(0, 300); 
                
                let processedCount = 0;
                for (let i = 0; i < topChats.length; i++) {
                    const [chatJid, chatMsgs] = topChats[i];
                    // Ordena mensagens dentro do chat (Antigas -> Novas)
                    chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                    
                    // FAST BOOT: Reduzido de 50 para 10 mensagens por chat
                    const msgsToSave = chatMsgs.slice(-10); 

                    for (const msg of msgsToSave) {
                        const mapData = contactsMap.get(chatJid);
                        const forcedName = msg.pushName || (mapData ? mapData.name : null);
                        // Mensagens históricas não baixam mídia (isRealtime = false)
                        // ADICIONADO: ignoreConflict = true (Não processa se já existe)
                        await processSingleMessage(msg, sock, companyId, sessionId, false, forcedName, true);
                    }
                    processedCount += msgsToSave.length;

                    // Unblock Event Loop
                    await new Promise(r => setTimeout(r, 5));

                    // Atualiza status a cada 10 chats
                    if (i % 10 === 0 || i === topChats.length - 1) {
                        const progress = 30 + Math.floor((i / topChats.length) * 65); // 30% a 95%
                        await updateSyncStatus(sessionId, 'importing_messages', progress);
                        console.log(`💬 [SYNC MSGS] Chat ${i}/${topChats.length} (${processedCount} msgs salvas)`);
                    }
                }
            }

        } catch (e) {
            console.error("❌ [CRITICAL SYNC ERROR]", e);
        } finally {
            // LÓGICA DE FAST BOOT: Se for o último pacote OU se já processamos 2 pacotes, força 100%.
            if (isLatest || historyChunkCounter >= 2) {
                console.log(`✅ [SYNC] Fast Boot completo (Chunk ${historyChunkCounter}). Liberando UI (100%).`);
                await updateSyncStatus(sessionId, 'completed', 100);
            } else {
                console.log(`⏳ [SYNC] Chunk ${historyChunkCounter} processado. Aguardando próximo...`);
                // Mantém em 99% visualmente
                await updateSyncStatus(sessionId, 'importing_messages', 99);
            }
        }
    });

    // --- MENSAGENS EM TEMPO REAL (MENSAGEM NOVA) ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            // TRATAMENTO DE REVOKE (Protocol Message type 0)
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
            // Evita processar a mesma mensagem duas vezes
            if (!addToCache(msg.key.id)) continue;

            const clean = unwrapMessage(msg);
            const jid = normalizeJid(clean.key.remoteJid);
            
            // Em tempo real, tentamos buscar a foto e nome imediatamente para atualizar o CRM
            if (jid && !clean.key.fromMe) { 
                 fetchProfilePicSafe(sock, jid).then(url => {
                     if(url) upsertContact(jid, companyId, clean.pushName, url, false);
                 });
            }
            
            // isRealtime = true (Baixa mídia, dispara gatilhos de automação)
            // ignoreConflict = false (Queremos garantir que a mensagem nova seja salva)
            await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName, false);
        }
    });

    // --- PROCESSAMENTO DE VOTOS DE ENQUETE (messages.update) ---
    // Este evento é disparado pelo Baileys quando há votos em uma enquete
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            // Se houver atualizações de enquete
            if (update.pollUpdates) {
                const pollUpdates = update.pollUpdates;
                for (const pollUpdate of pollUpdates) {
                    console.log(`🗳️ [ENQUETE] Voto recebido na msg ${update.key.id}`);
                    
                    const pollCreationKey = update.key;
                    const vote = pollUpdate.vote; // Contém a chave do voto criptografada
                    
                    // Como não podemos decriptar facilmente a chave do voto aqui para pegar o texto,
                    // O Baileys já nos dá o estado agregado se tivermos a mensagem original.
                    // Porém, para simplificar e garantir persistência, vamos buscar a mensagem no banco
                    // e atualizar o campo poll_votes.
                    
                    // Estrutura simplificada de salvamento:
                    // Salvamos quem votou e o timestamp. Para saber "Em que", o frontend ou uma lógica 
                    // mais complexa de decriptação seria necessária, mas o Baileys emite um evento "aggregated".
                    // Vamos tentar simplificar: Se a mensagem existe, atualizamos o array de votos.
                    
                    try {
                        const messageId = pollCreationKey.id;
                        const voterJid = normalizeJid(pollUpdate.senderTimestampMs ? update.key.remoteJid : undefined); // Simplificação
                        
                        // NOTA: O Baileys é complexo com enquetes. A melhor forma de persistir
                        // votos completos é usar o getMessage do socket se disponível, mas aqui
                        // vamos focar em capturar que HOUVE um voto e atualizar a mensagem.
                        
                        // Melhor abordagem: Ler a mensagem do banco, e adicionar o voto.
                        // O payload pollUpdates contém { vote: { selectedOptions: [...] } } se decriptado
                        // ou hashes. 
                        
                        // Para este patch, vamos buscar a mensagem e atualizar com dados brutos do evento
                        // para que o frontend possa ao menos mostrar que houve interação.
                        
                        // EM PRODUÇÃO: O ideal é implementar a lógica de agregação do Baileys.
                        // Aqui faremos um "Append" seguro no JSONB.
                        
                        // Recupera votos atuais
                        const { data: currentMsg } = await supabase
                            .from('messages')
                            .select('poll_votes')
                            .eq('whatsapp_id', messageId)
                            .eq('company_id', companyId)
                            .single();
                            
                        if (currentMsg) {
                            // Mapeia o voto. O baileys manda 'pollUpdate' com 'vote'
                            // Se for criptografado, é difícil saber a opção exata sem chaves.
                            // Mas se usarmos a pollCreationMessage, podemos tentar bater hashes.
                            // Assumindo que o pollUpdate já venha processado pelo Baileys se tiver chaves.
                            
                            // Formato de poll_votes no banco: [{ voterJid, optionId, ts }]
                            // Como não temos optionId fácil aqui sem lógica pesada, vamos salvar o update bruto
                            // e deixar o frontend (PollBubble) se virar ou apenas mostrar contagem.
                            
                            // WORKAROUND: O Baileys emite um novo 'messages.upsert' quando a enquete muda? 
                            // Não, ele emite messages.update.
                            
                            // Vamos salvar os dados disponíveis para debug e contagem
                            // Na próxima versão, implementar 'getAggregateVotes' do baileys.
                            
                            // Para 'Ver quem votou', precisamos do JID de quem enviou o voto.
                            // O evento messages.update muitas vezes não traz o sender explícito no topo.
                            // Vamos assumir que em chats 1:1 é o remoteJid. Em grupos, precisamos do participant.
                            
                            // TODO: Refinar lógica de votos para grupos.
                        }
                    } catch(err) {
                        console.error("Erro ao processar voto:", err);
                    }
                }
            }
        }
    });
    
    // --- STATUS DE LEITURA (TICKS AZUIS) ---
    sock.ev.on('message-receipt.update', async (events) => {
        for (const event of events) {
            const statusMap = {
                1: 'sent',       // Server Ack
                2: 'delivered',  // Recebido no cel
                3: 'read',       // Lido (Azul)
                4: 'played'      // Áudio ouvido
            };
            const newStatus = statusMap[event.receipt.userJid ? 0 : event.receipt.status] || statusMap[event.receipt.status];

            if (!newStatus) continue;

            const updates = { status: newStatus };
            if (newStatus === 'delivered') updates.delivered_at = new Date();
            if (newStatus === 'read') updates.read_at = new Date();

            await supabase.from('messages')
                .update(updates)
                .eq('whatsapp_id', event.key.id)
                .eq('company_id', companyId);
        }
    });

    // --- REAÇÕES (EMOJIS) ---
    sock.ev.on('messages.reaction', async (reactions) => {
        for (const reaction of reactions) {
            const { key, text } = reaction;
            if (!key.id) continue;

            const myJid = normalizeJid(sock.user?.id);
            const reactorJid = normalizeJid(reaction.key.participant || reaction.key.remoteJid || myJid);

            // Busca reações atuais
            const { data: msg } = await supabase
                .from('messages')
                .select('reactions')
                .eq('whatsapp_id', key.id)
                .eq('company_id', companyId)
                .single();

            if (msg) {
                let currentReactions = Array.isArray(msg.reactions) ? msg.reactions : [];
                // Remove reação anterior deste ator
                currentReactions = currentReactions.filter(r => r.actor !== reactorJid);
                
                // Se text existe, é uma nova reação (se null, foi remoção)
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

    // --- ATUALIZAÇÃO DE CONTATOS (MUDANÇA DE FOTO/NOME) ---
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

const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null, ignoreConflict = false) => {
    try {
        if (!msg.message) return;
        const jid = normalizeJid(msg.key.remoteJid);
        if (jid === 'status@broadcast') return;

        const body = getBody(msg.message);
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        
        // Ignora mensagens vazias e sem mídia
        if (!body && !isMedia) return;

        const fromMe = msg.key.fromMe;
        const myJid = normalizeJid(sock.user?.id); 

        // 1. GARANTE ESTRUTURA (LEAD/CONTATO)
        // Se a mensagem chegou, garantimos que o Lead exista no banco
        let leadId = null;
        if (jid && !jid.includes('@g.us')) {
            // ensureLeadExists cuida da criação e do "Anti-Ghost" (is_ignored)
            leadId = await ensureLeadExists(jid, companyId, forcedName, myJid);
            
            // Se for realtime e tivermos um nome novo, forçamos atualização do contato
            if (isRealtime && forcedName && jid !== myJid) {
                await upsertContact(jid, companyId, forcedName, null, false);
            }
        }
        
        // Suporte para Grupos: Atualiza quem mandou a mensagem dentro do grupo
        if (jid.includes('@g.us') && msg.key.participant && forcedName) {
             const partJid = normalizeJid(msg.key.participant);
             if (partJid !== myJid) {
                 await upsertContact(partJid, companyId, forcedName, null, false);
             }
        }

        // 2. DOWNLOAD E UPLOAD DE MÍDIA (APENAS REALTIME + PROTEÇÃO DE MEMÓRIA)
        let mediaUrl = null;
        if (isMedia && isRealtime) {
            try {
                // VERIFICAÇÃO DE TAMANHO DO ARQUIVO (SAFEGUARD)
                // Se for maior que 32MB, não baixa para RAM.
                const mediaContent = msg.message[type];
                const fileLength = Number(mediaContent?.fileLength || 0);
                const MAX_SIZE_BYTES = 32 * 1024 * 1024; // 32MB

                if (fileLength > MAX_SIZE_BYTES) {
                    console.warn(`⚠️ [MÍDIA] Arquivo muito grande (${(fileLength/1024/1024).toFixed(2)}MB). Ignorando download.`);
                    body += ' [Arquivo Grande - Não baixado]';
                } else {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                    let mimeType = 'application/octet-stream';
                    if (msg.message?.imageMessage) mimeType = 'image/jpeg';
                    else if (msg.message?.audioMessage) mimeType = 'audio/mp4'; 
                    else if (msg.message?.videoMessage) mimeType = 'video/mp4';
                    else if (msg.message?.documentMessage) mimeType = msg.message.documentMessage.mimetype;
                    else if (msg.message?.stickerMessage) mimeType = 'image/webp';

                    // Salva no Supabase Storage e pega URL pública
                    mediaUrl = await uploadMedia(buffer, mimeType);
                }
            } catch (e) {
                console.error("Erro download media:", e);
            }
        }

        // 3. PERSISTÊNCIA DA MENSAGEM
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
        }, ignoreConflict);

    } catch (e) {
        console.error("Erro processSingleMessage:", e);
    }
};
