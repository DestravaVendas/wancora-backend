import makeWASocket, { DisconnectReason, Browsers, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- ARQUITETURA DE MEMÓRIA ---
const sessions = new Map(); // sessionId -> Socket
const companyIndex = new Map(); // companyId -> sessionId
const retries = new Map();

// --- FUNÇÃO AUXILIAR 1: Extrai dados úteis da mensagem (Com Company ID) ---
const extractMessageData = (msg, sessionId, companyId) => {
    if (!msg.message) return null;
    if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return null;

    let remoteJid = msg.key.remoteJid;
    
    // 1. Normalização de JID (Evita duplicidade de chats)
    if (remoteJid.includes(':')) {
        remoteJid = remoteJid.split(':')[0] + '@s.whatsapp.net';
    }
    
    // Ignora Status e Broadcasts
    if (remoteJid === 'status@broadcast' || remoteJid.includes('@broadcast')) return null;

    const fromMe = msg.key.fromMe;
    
    let content = "";
    let messageType = "text";

    const m = msg.message;

    // Prioridade de extração de conteúdo
    if (m.conversation) content = m.conversation;
    else if (m.extendedTextMessage?.text) content = m.extendedTextMessage.text;
    else if (m.imageMessage) { content = m.imageMessage.caption || "[Imagem]"; messageType = "image"; }
    else if (m.videoMessage) { content = m.videoMessage.caption || "[Vídeo]"; messageType = "video"; }
    else if (m.audioMessage) { content = "[Áudio]"; messageType = "audio"; }
    else if (m.documentMessage) { content = m.documentMessage.fileName || "[Documento]"; messageType = "document"; }
    else if (m.stickerMessage) { content = "[Figurinha]"; messageType = "sticker"; }
    else if (m.locationMessage) { 
        content = `Loc: ${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude}`; 
        messageType = "location"; 
    }

    if (!content) return null;

    const messageTimestamp = msg.messageTimestamp 
        ? new Date(msg.messageTimestamp * 1000).toISOString() 
        : new Date().toISOString();

    return {
        session_id: sessionId,
        company_id: companyId, // 🛡️ CRÍTICO: Vincula ao Tenant
        remote_jid: remoteJid,
        from_me: fromMe,
        content: content,
        message_type: messageType,
        status: 'received',
        created_at: messageTimestamp
    };
};

// --- FUNÇÃO AUXILIAR 2: Salva Contato e Foto (Upsert) ---
const upsertContact = async (jid, sock, pushName = null, companyId = null) => {
    try {
        const isGroup = jid.endsWith('@g.us');
        let name = pushName;
        let profilePicUrl = null;

        // Tenta pegar foto (pode falhar por privacidade)
        try {
            profilePicUrl = await sock.profilePictureUrl(jid, 'image');
        } catch (e) { /* Silencioso */ }

        // Se for grupo e não tiver nome, tenta buscar metadata
        if (isGroup && !name) {
            try {
                const groupMetadata = await sock.groupMetadata(jid);
                name = groupMetadata.subject;
            } catch (e) { /* Silencioso */ }
        }

        const contactData = {
            jid: jid,
            profile_pic_url: profilePicUrl,
            updated_at: new Date()
        };
        
        if (name) {
            contactData.name = name;
            contactData.push_name = name;
        }
        
        // 🛡️ CRÍTICO: Vincula ao Tenant
        if (companyId) contactData.company_id = companyId;

        await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });

    } catch (err) {
        console.error(`Erro ao salvar contato ${jid}:`, err.message);
    }
};

// --- FUNÇÃO AUXILIAR 3: Salva mensagens em lote ---
const saveMessagesBatch = async (messages) => {
    if (!messages || messages.length === 0) return;
    const BATCH_SIZE = 50;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        try {
            const { error } = await supabase.from('messages').insert(batch);
            if (error) console.error("Erro ao salvar lote:", error.message);
        } catch (err) {
            console.error("Erro crítico no batch:", err.message);
        }
    }
    console.log(`[DB] ${messages.length} mensagens salvas.`);
};

// --- CORE: Iniciar Sessão ---
export const startSession = async (sessionId, companyId) => {
    // Limpeza prévia (Apenas memória)
    if (sessions.has(sessionId)) {
        await deleteSession(sessionId, companyId, false);
    }

    const { state, saveCreds } = await useSupabaseAuthState(sessionId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "silent" }), // Logs limpos
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: true, 
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 2000,
    });

    sock.companyId = companyId;
    sessions.set(sessionId, sock); 
    
    if (companyId) {
        companyIndex.set(companyId, sessionId);
        console.log(`[INIT] Empresa ${companyId} :: Sessão ${sessionId}`);
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection === 'connecting') {
            await supabase.from("instances").update({ status: "connecting" }).eq("session_id", sessionId);
        }
        
        if (qr) {
            await supabase.from("instances").upsert({ 
                session_id: sessionId, 
                qrcode_url: qr, 
                status: "qrcode", 
                company_id: companyId, 
                name: "WhatsApp Principal" 
            }, { onConflict: 'session_id' });
        }

        if (connection === "close") {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
            sessions.delete(sessionId);
            
            if (shouldReconnect) {
                const attempt = (retries.get(sessionId) || 0) + 1;
                retries.set(sessionId, attempt);
                const delay = Math.min(attempt * 2000, 10000);
                setTimeout(() => startSession(sessionId, companyId), delay);
            } else {
                await deleteSession(sessionId, companyId);
            }
        }

        if (connection === "open") {
            console.log(`[OPEN] Conexão estabelecida para ${companyId}!`);
            retries.set(sessionId, 0);
            
            await supabase.from("instances").update({ 
                status: "connected", 
                qrcode_url: null 
            }).eq("session_id", sessionId);

            // 🚀 SYNC INICIAL: Busca Grupos
            try {
                const groups = await sock.groupFetchAllParticipating();
                for (const g of Object.values(groups)) {
                    await upsertContact(g.id, sock, g.subject, companyId);
                }
            } catch (e) {}
        }
    });

    // --- EVENTOS DE HISTÓRICO E MENSAGENS ---
    sock.ev.on("messaging-history.set", async ({ messages, contacts }) => {
        console.log(`[HISTORY] Processando ${messages.length} mensagens e ${contacts?.length || 0} contatos...`);
        
        // Salva Mensagens
        const formattedMessages = messages.map(msg => extractMessageData(msg, sessionId, companyId)).filter(Boolean);
        await saveMessagesBatch(formattedMessages);

        // Salva Contatos
        if (contacts) {
            const contactBatch = contacts.map(c => ({
                jid: c.id,
                name: c.name || c.notify || c.verifiedName,
                push_name: c.notify,
                company_id: companyId,
                updated_at: new Date()
            }));
            
            const BATCH = 50;
            for (let i = 0; i < contactBatch.length; i += BATCH) {
                await supabase.from('contacts').upsert(contactBatch.slice(i, i + BATCH), { onConflict: 'jid' });
            }
        }
    });

    sock.ev.on("contacts.upsert", async (contacts) => {
        for (const c of contacts) {
            await upsertContact(c.id, sock, c.name || c.notify, companyId);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== 'notify') return; // Ignora appends irrelevantes

        const formattedMessages = messages.map(msg => extractMessageData(msg, sessionId, companyId)).filter(Boolean);

        if (formattedMessages.length > 0) {
            console.log(`[MSG] Nova mensagem para ${companyId}`);
            await supabase.from('messages').insert(formattedMessages);
            
            // Atualiza contato do remetente
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.key.remoteJid) {
                    await upsertContact(msg.key.remoteJid, sock, msg.pushName, companyId);
                }
            }
        }
    });

    return sock;
};

// --- AQUI ESTÁ A LÓGICA DE LIMPEZA (FACTORY RESET) ---
export const deleteSession = async (sessionId, companyId, clearDb = true) => {
    console.log(`[DELETE] Expurgo da sessão ${sessionId}...`);
    const sock = sessions.get(sessionId);
    
    if (sock) { 
        try { sock.end(undefined); } catch (e) {} 
    }
    
    sessions.delete(sessionId);
    if (companyId) companyIndex.delete(companyId);

    if (clearDb) {
        // 1. Remove Instância e Sessão Auth
        await supabase.from("instances").delete().eq("session_id", sessionId);
        await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);

        // 2. 🔥 LIMPEZA TOTAL: Remove histórico de Mensagens e Contatos da Empresa
        if (companyId) {
            console.log(`[WIPE] Limpando dados da empresa ${companyId}...`);
            await supabase.from("messages").delete().eq("company_id", companyId);
            await supabase.from("contacts").delete().eq("company_id", companyId);
        }
    }
    return true;
};

export const sendMessage = async (sessionId, to, text) => {
    const sock = sessions.get(sessionId);
    if (!sock) throw new Error("Sessão não ativa");
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    return await sock.sendMessage(jid, { text });
};

export const getSessionId = (companyId) => {
    return companyIndex.get(companyId);
};

export const getSession = (companyId) => {
    const sessionId = companyIndex.get(companyId);
    if (!sessionId) {
        console.warn(`[WARN] Sessão não encontrada via index para empresa ${companyId}.`);
        return null;
    }
    return sessions.get(sessionId);
};
