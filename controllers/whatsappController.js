// controllers/whatsappController.js
import makeWASocket, { 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    delay,
    downloadMediaMessage 
} from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import mime from "mime-types";

// CHECAGEM DE SEGURANÇA
if (!process.env.SUPABASE_KEY || !process.env.SUPABASE_URL) {
    console.error("❌ ERRO FATAL: Chaves do Supabase não encontradas no .env");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const sessions = new Map();      
const companyIndex = new Map();  
const retries = new Map(); 
const reconnectTimers = new Map();      
const lastQrUpdate = new Map(); 

// --- HELPER: Upload de Mídia ---
const uploadMediaToSupabase = async (buffer, type) => {
    try {
        const fileExt = mime.extension(type) || 'bin';
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `chat-media/${fileName}`;

        const { error } = await supabase.storage
            .from('chat-media')
            .upload(filePath, buffer, { contentType: type, upsert: false });

        if (error) throw error;

        const { data } = supabase.storage.from('chat-media').getPublicUrl(filePath);
        return data.publicUrl;
    } catch (err) {
        console.error('❌ Erro upload media:', err.message);
        return null;
    }
};

// --- HELPER: Anti-Ghost Inteligente ---
const ensureLeadExists = async (remoteJid, pushName, companyId) => {
    try {
        if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us')) return null;
        const phone = remoteJid.split('@')[0];

        // Verifica ignore
        const { data: contact } = await supabase.from('contacts').select('is_ignored').eq('jid', remoteJid).maybeSingle();
        if (contact && contact.is_ignored) {
            console.log(`🚫 [Anti-Ghost] Contato ${phone} ignorado (Config do usuário).`);
            return null;
        }

        const { data: existingLead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
        if (existingLead) return existingLead.id;

        console.log(`🆕 [Anti-Ghost] Criando Lead para ${phone}...`);

        // Pega primeira etapa
        const { data: firstStage } = await supabase.from('pipeline_stages').select('id').eq('company_id', companyId).order('position', { ascending: true }).limit(1).maybeSingle();
        const stageId = firstStage?.id || null;

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            name: pushName || `Novo Contato (${phone})`,
            phone: phone,
            status: 'new',
            pipeline_stage_id: stageId 
        }).select('id').single();

        return newLead?.id || null;
    } catch (e) {
        console.error("Erro ensureLeadExists:", e);
        return null;
    }
};

// --- HELPER: Upsert Contato ---
const upsertContact = async (jid, sock, pushName = null, companyId = null, savedName = null, imgUrl = null) => {
    try {
        const cleanJid = jid.split(':')[0] + (jid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net');
        const contactData = { jid: cleanJid, company_id: companyId, updated_at: new Date() };
        if (savedName) contactData.name = savedName; 
        if (pushName) contactData.push_name = pushName;
        if (imgUrl) contactData.profile_pic_url = imgUrl;
        await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
    } catch (e) {}
};

// Helpers de Conteúdo
const getMessageContent = (msg) => {
    if (!msg) return "";
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    return "";
};

const getMessageType = (msg) => {
    if (msg.imageMessage) return 'image';
    if (msg.audioMessage) return 'audio';
    if (msg.videoMessage) return 'video';
    if (msg.documentMessage) return 'document';
    if (msg.pollCreationMessage || msg.pollCreationMessageV3) return 'poll';
    if (msg.locationMessage) return 'location';
    if (msg.contactMessage) return 'contact';
    return 'text';
};

// ==============================================================================
// CORE: START SESSION
// ==============================================================================
export const startSession = async (sessionId, companyId) => {
    console.log(`[START] Sessão ${sessionId} (Empresa: ${companyId})`);
    
    if (sessions.has(sessionId)) {
        await deleteSession(sessionId, companyId, false);
    }

    const { state, saveCreds } = await useSupabaseAuthState(sessionId);
    let version = [2, 3000, 1015901307];
    try { const v = await fetchLatestBaileysVersion(); version = v.version; } catch (e) {}

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Wancora CRM", "Chrome", "10.0"],
        syncFullHistory: true, 
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        generateHighQualityLinkPreview: true,
    });

    sock.companyId = companyId;
    sessions.set(sessionId, sock); 
    if (companyId) companyIndex.set(companyId, sessionId);

    sock.ev.on("creds.update", saveCreds);

    // --- 1. HISTÓRICO INTELIGENTE (CHUNKED) ---
    // Corrige o problema de só pegar 50 msgs e evita travamento do node
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        console.log(`📚 [HISTÓRICO] Recebido. Contatos: ${contacts.length}, Msgs: ${messages.length}`);

        // A. Salvar Contatos
        const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net'));
        if (validContacts.length > 0) {
            // Upsert em batch é seguro para contatos
            const batch = validContacts.map(c => ({
                jid: c.id,
                name: c.name || c.verifiedName || null,
                push_name: c.notify || null,
                company_id: companyId,
                updated_at: new Date()
            }));
            await supabase.from('contacts').upsert(batch, { onConflict: 'jid' });
        }

        // B. Salvar Mensagens em CHUNKS (Lotes)
        // Isso resolve o problema de memória e de "histórico incompleto"
        const CHUNK_SIZE = 50; 
        const totalMessages = messages.length;
        
        console.log(`📚 [HISTÓRICO] Processando ${totalMessages} mensagens em lotes de ${CHUNK_SIZE}...`);

        for (let i = 0; i < totalMessages; i += CHUNK_SIZE) {
            const chunk = messages.slice(i, i + CHUNK_SIZE);
            
            // Processa o lote em paralelo para velocidade, mas espera o lote acabar para ir pro próximo
            await Promise.all(chunk.map(msg => processMessage(msg, sessionId, companyId, sock, false)));
            
            // Pequeno delay para não sufocar o Event Loop do Node ou o Banco
            await delay(100); 
            
            if (i % 500 === 0 && i > 0) console.log(`📚 [HISTÓRICO] Progresso: ${i}/${totalMessages}`);
        }
        
        console.log(`✅ [HISTÓRICO] Sincronização concluída.`);
    });

    // --- 2. CONTATOS ---
    sock.ev.on("contacts.upsert", async (contacts) => {
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

    // --- 3. GRUPOS ---
    sock.ev.on("groups.update", async (groups) => {
        for (const g of groups) {
            if (g.subject) await upsertContact(g.id, sock, null, companyId, g.subject);
        }
    });

    // --- 4. CONEXÃO ---
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (!sessions.has(sessionId)) return; 

        if (connection) console.log(`🔌 [CONN] Sessão ${sessionId}: ${connection}`);

        if (qr) {
            const now = Date.now();
            const lastTime = lastQrUpdate.get(sessionId) || 0;
            if (now - lastTime > 800) {
                lastQrUpdate.set(sessionId, now);
                await supabase.from("instances").update({ qrcode_url: qr, status: "qrcode", updated_at: new Date() }).eq('session_id', sessionId);
            }
        }

        if (connection === "close") {
            lastQrUpdate.delete(sessionId);
            if (reconnectTimers.has(sessionId)) { clearTimeout(reconnectTimers.get(sessionId)); reconnectTimers.delete(sessionId); }

            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode === 401 || statusCode === 403) {
                 await deleteSession(sessionId, companyId, true);
                 return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && sessions.has(sessionId)) {
                await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
                const attempt = (retries.get(sessionId) || 0) + 1;
                retries.set(sessionId, attempt);
                const delayMs = Math.min(attempt * 2000, 10000);
                const timeoutId = setTimeout(() => { if (sessions.has(sessionId)) startSession(sessionId, companyId); }, delayMs);
                reconnectTimers.set(sessionId, timeoutId);
            } else {
                await deleteSession(sessionId, companyId, false);
            }
        }

        if (connection === "open") {
            retries.set(sessionId, 0);
            await supabase.from("instances").update({ status: "connected", qrcode_url: null, updated_at: new Date() }).eq("session_id", sessionId);
            setTimeout(async () => {
                 const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                 try { 
                     const myPic = await sock.profilePictureUrl(userJid, 'image'); 
                     if(myPic) await supabase.from("instances").update({ profile_pic_url: myPic }).eq("session_id", sessionId);
                 } catch(e){}
            }, 2000);
        }
    });

    // --- 5. RECEBIMENTO (REALTIME DEBUG) ---
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!sessions.has(sessionId)) return;
        
        console.log(`📨 [REALTIME] Upsert recebido. Tipo: ${type}. Qtd: ${messages.length}`);

        if (type === "notify" || type === "append") {
            for (const msg of messages) {
                await processMessage(msg, sessionId, companyId, sock, true);
            }
        }
    });

    return sock;
};

// --- PROCESSAMENTO DETALHADO (DEBUGGER FOFQUEIRO) ---
const processMessage = async (msg, sessionId, companyId, sock, shouldDownloadMedia = false) => {
    try {
        if (!msg.message) return;
        
        const remoteJid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const whatsappId = msg.key.id; 
        const pushName = msg.pushName;

        // --- FILTROS DE SEGURANÇA (LOGADOS) ---
        if (remoteJid === 'status@broadcast') {
            // console.log('[DEBUG] Ignorando status update'); 
            return; 
        }
        if (remoteJid.includes('@lid')) { 
            console.log(`[DEBUG] Ignorando mensagem de LID: ${remoteJid}`); 
            return; 
        } 
        if (remoteJid.includes('@broadcast')) return;

        let content = getMessageContent(msg.message);
        let msgType = getMessageType(msg.message);
        let mediaUrl = null;

        // Ignora mensagens vazias e sem mídia
        if (!content && msgType === 'text') {
            console.log(`[DEBUG] Mensagem vazia de ${remoteJid}. Ignorando.`);
            return;
        }

        // LOG DO SUCESSO DO PARSER
        console.log(`⚡ [PROCESS] Msg de: ${remoteJid} | Tipo: ${msgType} | FromMe: ${fromMe} | Content: ${content?.substring(0, 20)}...`);

        await upsertContact(remoteJid, sock, pushName, companyId);

        let leadId = null;
        if (!remoteJid.includes('@g.us')) {
            leadId = await ensureLeadExists(remoteJid, pushName, companyId);
        }

        // DOWNLOAD MÍDIA
        if (shouldDownloadMedia && ['image', 'video', 'audio', 'document'].includes(msgType)) {
            try {
                console.log(`📥 [MEDIA] Baixando mídia...`);
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                
                let mimetype = 'application/octet-stream';
                if (msg.message.imageMessage) mimetype = 'image/jpeg';
                else if (msg.message.audioMessage) mimetype = 'audio/mp4'; 
                else if (msg.message.videoMessage) mimetype = 'video/mp4';
                else if (msg.message.documentMessage) mimetype = msg.message.documentMessage.mimetype;

                mediaUrl = await uploadMediaToSupabase(buffer, mimetype);
                console.log(`📤 [MEDIA] Upload OK: ${mediaUrl}`);
            } catch (mediaErr) {
                console.error('❌ [MEDIA] Falha no download:', mediaErr.message);
            }
        }

        // Parse POLL
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

        // --- SALVAMENTO NO BANCO ---
        const { error } = await supabase.from('messages').upsert({
            company_id: companyId,
            session_id: sessionId,
            remote_jid: remoteJid,
            whatsapp_id: whatsappId,
            from_me: fromMe,
            content: content || '[Mídia]',
            message_type: msgType,
            media_url: mediaUrl, 
            status: fromMe ? 'sent' : 'received',
            lead_id: leadId, 
            created_at: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date()
        }, { 
            onConflict: 'remote_jid, whatsapp_id'
        });

        if (error) {
            console.error(`❌ [DB ERROR] Falha ao salvar msg ${whatsappId}:`, error.message);
        } else {
            // console.log(`✅ [DB OK] Msg salva.`); // Descomente se quiser muito flood
        }

    } catch (e) {
        console.error("❌ [CRASH] Erro processamento msg:", e);
    }
};

// --- ENVIO (ATUALIZADO) ---
export const sendMessage = async (sessionId, to, payload) => {
    const sock = sessions.get(sessionId);
    if (!sock) throw new Error("Sessão não ativa");
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    let sentMsg;

    try {
        console.log(`[SEND] Enviando para ${jid}. Tipo: ${payload.type}`);

        switch (payload.type) {
            case 'text':
                if (payload.text && payload.text.startsWith('Chave Pix:')) {
                    sentMsg = await sock.sendMessage(jid, { text: payload.text });
                } else {
                    sentMsg = await sock.sendMessage(jid, { text: payload.content || payload.text || "" });
                }
                break;

            case 'image':
                sentMsg = await sock.sendMessage(jid, { 
                    image: { url: payload.url }, 
                    caption: payload.caption 
                });
                break;

            case 'video':
                sentMsg = await sock.sendMessage(jid, { 
                    video: { url: payload.url }, 
                    caption: payload.caption 
                });
                break;

            case 'audio':
                // Suporte CRÍTICO a PTT vs Arquivo de Áudio
                const isPtt = payload.ptt === true; 
                sentMsg = await sock.sendMessage(jid, { 
                    audio: { url: payload.url }, 
                    mimetype: 'audio/mp4', // WhatsApp exige isso
                    ptt: isPtt 
                });
                break;

            case 'document':
                sentMsg = await sock.sendMessage(jid, { 
                    document: { url: payload.url }, 
                    mimetype: payload.mimetype || 'application/pdf',
                    fileName: payload.fileName || 'documento'
                });
                break;

            case 'poll':
                if (!payload.poll || !payload.poll.options || payload.poll.options.length < 2) {
                    throw new Error("Invalid poll values: Mínimo 2 opções requeridas.");
                }
                sentMsg = await sock.sendMessage(jid, {
                    poll: {
                        name: payload.poll.name,
                        values: payload.poll.options, 
                        selectableCount: payload.poll.selectableOptionsCount || 1
                    }
                });
                break;

            case 'location':
                sentMsg = await sock.sendMessage(jid, {
                    location: {
                        degreesLatitude: payload.location.latitude,
                        degreesLongitude: payload.location.longitude
                    }
                });
                break;

            case 'contact':
                sentMsg = await sock.sendMessage(jid, {
                    contacts: {
                        displayName: payload.contact.displayName,
                        contacts: [{ vcard: payload.contact.vcard }]
                    }
                });
                break;

            default:
                sentMsg = await sock.sendMessage(jid, { text: payload.text || payload.content || "" });
        }

        return sentMsg;
    } catch (err) {
        console.error("❌ Erro no envio:", err);
        throw err;
    }
};

export const deleteSession = async (sessionId, companyId, clearDb = true) => {
    console.log(`[DELETE] Sessão ${sessionId}`);
    if (companyId) companyIndex.delete(companyId);
    
    lastQrUpdate.delete(sessionId);
    if (reconnectTimers.has(sessionId)) { clearTimeout(reconnectTimers.get(sessionId)); reconnectTimers.delete(sessionId); }

    const sock = sessions.get(sessionId);
    sessions.delete(sessionId);
    retries.delete(sessionId);
    
    if (sock) { 
        try { 
            sock.ev.removeAllListeners("connection.update");
            sock.ev.removeAllListeners("creds.update");
            sock.ev.removeAllListeners("messages.upsert");
            sock.ev.removeAllListeners("messaging-history.set");
            sock.ev.removeAllListeners("contacts.upsert");
            sock.end(undefined); 
        } catch (e) {} 
    }

    if (clearDb) {
        await supabase.from("instances").delete().eq("session_id", sessionId);
        await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);
    }
    return true;
};

export const getSessionId = (companyId) => companyIndex.get(companyId);
export const getSession = (companyId) => {
    const sessionId = companyIndex.get(companyId);
    return sessionId ? sessions.get(sessionId) : null;
};
