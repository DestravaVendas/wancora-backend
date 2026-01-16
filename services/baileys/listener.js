
import { DisconnectReason, downloadMediaMessage, delay, getAggregateVotesInPollMessage } from '@whiskeysockets/baileys';
import { 
    updateInstance, 
    upsertContact, 
    ensureLeadExists, 
    saveMessageToDb, 
    uploadMediaToSupabase, 
    smartUpdateLeadName,
    deleteSessionData,
    updateSyncStatus, // Importado
    savePollVote,     // Importado
    supabase
} from '../crm/sync.js';
import { unwrapMessage, getMessageContent, getMessageType } from '../../utils/wppParsers.js';
import { deleteSession } from './connection.js';

// Controle de Throttle para QR Code (Memória Local)
const lastQrUpdate = new Map();

/**
 * Configura todos os eventos do Socket
 */
export const setupListeners = ({ sock, sessionId, companyId, saveCreds, reconnectFn, logger }) => {
    
    // 1. CREDENCIAIS
    sock.ev.on('creds.update', saveCreds);

    // 2. CONEXÃO & QR CODE
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection) console.log(`🔌 [CONN] ${sessionId}: ${connection}`);

        if (qr) {
            const now = Date.now();
            const lastTime = lastQrUpdate.get(sessionId) || 0;
            if (now - lastTime > 800) {
                lastQrUpdate.set(sessionId, now);
                console.log(`[${sessionId}] Novo QR Code.`);
                await updateInstance(sessionId, { 
                    status: 'qrcode', 
                    qrcode_url: qr,
                    company_id: companyId 
                });
            }
        }

        if (connection === 'close') {
            lastQrUpdate.delete(sessionId);
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            
            if (statusCode === 401 || statusCode === 403) {
                console.log(`[${sessionId}] Logout Detectado. Limpando dados.`);
                await updateInstance(sessionId, { status: 'disconnected', qrcode_url: null });
                await deleteSessionData(sessionId);
                await deleteSession(sessionId); 
                return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                await updateInstance(sessionId, { status: 'disconnected' });
                reconnectFn();
            } else {
                await deleteSessionData(sessionId);
                await deleteSession(sessionId);
            }
        }

        if (connection === 'open') {
            console.log(`[${sessionId}] Conectado! 🟢`);
            
            // SYNC PROTOCOL: START
            // Define status inicial para que o Frontend mostre o Loading Overlay
            await updateInstance(sessionId, { 
                status: 'connected', 
                qrcode_url: null,
                profile_pic_url: null,
                sync_status: 'importing_contacts', 
                sync_percent: 5
            });

            setTimeout(async () => {
                try {
                    const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    const ppUrl = await sock.profilePictureUrl(userJid, 'image');
                    if(ppUrl) await updateInstance(sessionId, { profile_pic_url: ppUrl });
                } catch(e) {}
            }, 3000);
        }
    });

    // 3. HISTÓRICO INTELIGENTE COM SYNC SAFE (Contatos ANTES de Mensagens)
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        console.log(`📚 [HISTÓRICO] Recebendo pacote... Iniciando Protocolo Safe Sync.`);

        // --- PASSO 1: CONTATOS (Sync First) ---
        await updateSyncStatus(sessionId, 'importing_contacts', 10);
        
        const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net'));
        if (validContacts.length > 0) {
            console.log(`[SYNC] Salvando ${validContacts.length} contatos...`);
            const batch = validContacts.map(c => ({
                jid: c.id,
                name: c.name || c.verifiedName || null,
                push_name: c.notify || null,
                company_id: companyId,
                updated_at: new Date()
            }));
            await supabase.from('contacts').upsert(batch, { onConflict: 'jid' });
        }
        
        await updateSyncStatus(sessionId, 'importing_messages', 40);

        // --- PASSO 2: FILTRO DE MENSAGENS ---
        const MAX_CHATS = 100;           
        const MAX_MSGS_PER_CHAT = 15;    
        const MONTHS_LIMIT = 3;          
        
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - MONTHS_LIMIT);
        const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

        const messagesByChat = new Map();
        messages.forEach(msg => {
            const unwrapped = unwrapMessage(msg);
            const jid = unwrapped.key.remoteJid;
            
            const msgTime = unwrapped.messageTimestamp || 0;
            if (msgTime < cutoffTimestamp) return;

            if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
            messagesByChat.get(jid).push(unwrapped);
        });

        // Seleciona Top Chats
        const chatSortArray = [];
        messagesByChat.forEach((msgs, jid) => {
            const lastMsgTime = Math.max(...msgs.map(m => m.messageTimestamp || 0));
            chatSortArray.push({ jid, time: lastMsgTime });
        });

        chatSortArray.sort((a, b) => b.time - a.time);
        const topChats = new Set(chatSortArray.slice(0, MAX_CHATS).map(c => c.jid));

        const smartMessages = [];
        messagesByChat.forEach((chatMsgs, jid) => {
            if (!topChats.has(jid)) return;
            chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
            const limitedMsgs = chatMsgs.slice(-MAX_MSGS_PER_CHAT);
            smartMessages.push(...limitedMsgs);
        });

        console.log(`💾 [DB SAVE] Processando ${smartMessages.length} mensagens.`);
        await updateSyncStatus(sessionId, 'importing_messages', 60);

        // --- PASSO 3: SALVAMENTO EM LOTE ---
        const CHUNK_SIZE = 50;
        let processed = 0;
        
        for (let i = 0; i < smartMessages.length; i += CHUNK_SIZE) {
            const chunk = smartMessages.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(msg => processSingleMessage(msg, sessionId, companyId, sock, false))); 
            
            processed += chunk.length;
            const progress = 60 + Math.floor((processed / smartMessages.length) * 35); // Vai até 95%
            await updateSyncStatus(sessionId, 'importing_messages', progress);
            
            await delay(100); 
        }
        
        console.log(`✅ [HISTÓRICO] Sync Concluído.`);
        await updateSyncStatus(sessionId, 'completed', 100);
    });

    // 4. ATUALIZAÇÃO DE CONTATOS
    sock.ev.on('contacts.upsert', async (contacts) => {
        const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net'));
        if (validContacts.length > 0) {
            const batch = validContacts.map(c => ({
                jid: c.id,
                name: c.name || c.verifiedName || null,
                push_name: c.notify || null,
                company_id: companyId,
                updated_at: new Date()
            }));
            await supabase.from('contacts').upsert(batch, { onConflict: 'jid' });
        }
    });

    // 5. ATUALIZAÇÃO DE GRUPOS
    sock.ev.on('groups.update', async (groups) => {
        for (const g of groups) {
            if (g.subject) {
                await upsertContact(g.id, sock, null, companyId, g.subject);
            }
        }
    });

    // 6. MENSAGENS EM TEMPO REAL
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        console.log(`📨 [REALTIME] Recebidas: ${messages.length}`);

        for (const msg of messages) {
            const cleanMsg = unwrapMessage(msg);
            // Mensagens realtime sempre baixam mídia (true)
            await processSingleMessage(cleanMsg, sessionId, companyId, sock, true);
        }
    });

    // 7. LISTENER DE ENQUETES (VOTOS)
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            // Verifica se há atualização de enquete
            if (update.pollUpdates) {
                // A implementação exata depende de como o Baileys expõe no evento update
                // Aqui tentamos processar os votos brutos e salvar no banco
                for (const pollVote of update.pollUpdates) {
                     if (pollVote.vote) {
                         const voterJid = pollVote.voteKey?.fromMe 
                            ? sock.user.id.split(':')[0] + '@s.whatsapp.net' 
                            : pollVote.voteKey?.remoteJid;
                         
                         const selectedOptions = pollVote.vote.selectedOptions || [];
                         
                         // Se tiver opções selecionadas, pega a primeira (simplificação para salvar o voto)
                         // Em produção, seria ideal mapear o hash da opção para o índice
                         if(selectedOptions.length > 0) {
                             // Como não temos o hash map aqui fácil sem a mensagem original, 
                             // vamos salvar apenas se conseguirmos inferir ou se o frontend enviar.
                             // MAS, o evento messages.update é vital.
                             // Vamos tentar salvar o update bruto se necessário, ou apenas logar.
                             console.log(`[POLL UPDATE] Voto recebido de ${voterJid}`);
                         }
                     }
                }
            }
        }
    });
};

// --- Processador Unificado ---
const processSingleMessage = async (msg, sessionId, companyId, sock, shouldDownloadMedia = false) => {
    try {
        if (!msg.message) return;
        
        const remoteJid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const whatsappId = msg.key.id; 
        const pushName = msg.pushName;

        if (remoteJid === 'status@broadcast') return; 
        if (remoteJid.includes('@broadcast')) return;

        let content = getMessageContent(msg.message);
        let msgType = getMessageType(msg.message);
        let mediaUrl = null;

        if (!content && msgType === 'text') {
            if (!msg.message.stickerMessage) return;
        }

        console.log(`⚡ [MSG] ${remoteJid} | Tipo: ${msgType}`);

        await upsertContact(remoteJid, sock, pushName, companyId);

        let leadId = null;
        if (!remoteJid.includes('@g.us')) {
            leadId = await ensureLeadExists(remoteJid, pushName, companyId);
            
            if (!fromMe) {
                const phone = remoteJid.split('@')[0];
                await smartUpdateLeadName(phone, pushName, companyId);
            }
        }

        const supportedTypes = ['image', 'video', 'audio', 'document', 'sticker'];
        if (shouldDownloadMedia && supportedTypes.includes(msgType)) {
            try {
                const specificMsg = msg.message[msgType + 'Message'] || msg.message;
                const fileSize = specificMsg?.fileLength;
                
                if (fileSize && Number(fileSize) > 50 * 1024 * 1024) { 
                    console.warn(`⚠️ Mídia > 50MB. Ignorando.`);
                    content = `[Arquivo Grande > 50MB]`;
                } else {
                    console.log(`📥 [MEDIA] Baixando...`);
                    const buffer = await downloadMediaMessage(
                        msg, 
                        'buffer', 
                        {}, 
                        { logger: { level: 'silent' } }
                    );
                    
                    let mimetype = 'application/octet-stream';
                    if (msg.message.imageMessage) mimetype = 'image/jpeg';
                    else if (msg.message.audioMessage) mimetype = 'audio/mp4'; 
                    else if (msg.message.videoMessage) mimetype = 'video/mp4';
                    else if (msg.message.documentMessage) mimetype = msg.message.documentMessage.mimetype;
                    else if (msg.message.stickerMessage) mimetype = 'image/webp';

                    mediaUrl = await uploadMediaToSupabase(buffer, mimetype);
                }
            } catch (mediaErr) {
                console.error('❌ [MEDIA] Erro download:', mediaErr.message);
                content = `[Erro no Download]`;
                msgType = 'text'; 
            }
        }

        if (msgType === 'poll') {
            try {
                const pollData = msg.message.pollCreationMessage || msg.message.pollCreationMessageV3;
                if (pollData) {
                    content = JSON.stringify({
                        name: pollData.name,
                        options: pollData.options.map(o => o.optionName),
                        selectableOptionsCount: pollData.selectableOptionsCount
                    });
                }
            } catch(e) { content = 'Enquete'; }
        }

        await saveMessageToDb({
            companyId,
            sessionId,
            remoteJid,
            whatsappId,
            fromMe,
            content: content || (mediaUrl ? '[Mídia]' : ''), 
            messageType: msgType,
            mediaUrl,
            leadId,
            timestamp: msg.messageTimestamp
        });

    } catch (e) {
        console.error("❌ [LISTENER] Erro processamento:", e);
    }
};
