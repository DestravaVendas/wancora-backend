
import { DisconnectReason, downloadMediaMessage, delay } from '@whiskeysockets/baileys';
import { 
    updateInstance, 
    upsertContact, 
    ensureLeadExists, 
    saveMessageToDb, 
    uploadMediaToSupabase, 
    smartUpdateLeadName,
    deleteSessionData,
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
            await updateInstance(sessionId, { 
                status: 'connected', 
                qrcode_url: null,
                profile_pic_url: null 
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

    // 3. HISTÓRICO INTELIGENTE COM PROTEÇÃO DE MEMÓRIA
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        console.log(`📚 [HISTÓRICO] Recebendo pacote... Aplicando filtros de segurança.`);

        // --- FILTROS ANTI-CRASH ---
        const MAX_CHATS = 100;           // Top 100 conversas recentes
        const MAX_MSGS_PER_CHAT = 10;    // Últimas 10 msgs (aumentei um pouco do sugerido)
        const MONTHS_LIMIT = 3;          // Últimos 3 meses (mais seguro que 6)
        
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - MONTHS_LIMIT);
        const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

        // 1. Upsert Contatos (Leve)
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

        // 2. Agrupa Mensagens e Filtra por Data
        const messagesByChat = new Map();
        messages.forEach(msg => {
            const unwrapped = unwrapMessage(msg);
            const jid = unwrapped.key.remoteJid;
            
            // Descarta mensagens muito antigas
            const msgTime = unwrapped.messageTimestamp || 0;
            if (msgTime < cutoffTimestamp) return;

            if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
            messagesByChat.get(jid).push(unwrapped);
        });

        // 3. Seleciona Top Chats Recentes
        const chatSortArray = [];
        messagesByChat.forEach((msgs, jid) => {
            const lastMsgTime = Math.max(...msgs.map(m => m.messageTimestamp || 0));
            chatSortArray.push({ jid, time: lastMsgTime });
        });

        chatSortArray.sort((a, b) => b.time - a.time);
        const topChats = new Set(chatSortArray.slice(0, MAX_CHATS).map(c => c.jid));

        console.log(`🧠 [SMART SYNC] Filtrado: ${messagesByChat.size} chats -> ${topChats.size} chats relevantes.`);

        const smartMessages = [];

        // 4. Aplica Limite por Chat e Achata Array
        messagesByChat.forEach((chatMsgs, jid) => {
            if (!topChats.has(jid)) return;

            chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
            const limitedMsgs = chatMsgs.slice(-MAX_MSGS_PER_CHAT);
            smartMessages.push(...limitedMsgs);
        });

        console.log(`💾 [DB SAVE] Processando ${smartMessages.length} mensagens finais.`);

        // 5. Salva em Blocos (Chunking)
        const CHUNK_SIZE = 50;
        for (let i = 0; i < smartMessages.length; i += CHUNK_SIZE) {
            const chunk = smartMessages.slice(i, i + CHUNK_SIZE);
            // FALSE no download de mídia para histórico antigo (Vital!)
            await Promise.all(chunk.map(msg => processSingleMessage(msg, sessionId, companyId, sock, false))); 
            await delay(100); 
        }
        
        console.log(`✅ [HISTÓRICO] Sync Otimizado Concluído.`);
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
