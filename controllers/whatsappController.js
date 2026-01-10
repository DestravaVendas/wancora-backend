import makeWASocket, { DisconnectReason, Browsers, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// CHECAGEM DE SEGURANÇA
if (!process.env.SUPABASE_KEY || !process.env.SUPABASE_URL) {
    console.error("❌ ERRO FATAL: Chaves do Supabase não encontradas no .env");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- ARQUITETURA DE MEMÓRIA ---
const sessions = new Map();
const companyIndex = new Map();
const retries = new Map();

// --- AUX 1: Extrai dados da mensagem (LÓGICA COMPLETA) ---
const extractMessageData = (msg, sessionId, companyId) => {
    if (!msg.message) return null;
    if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return null;

    let remoteJid = msg.key.remoteJid;
    
    // Normalização de JID
    if (remoteJid.includes(':')) {
        remoteJid = remoteJid.split(':')[0] + '@s.whatsapp.net';
    }
    
    if (remoteJid === 'status@broadcast' || remoteJid.includes('@broadcast')) return null;

    const fromMe = msg.key.fromMe;
    let content = "";
    let messageType = "text";
    const m = msg.message;

    // Prioridade de Extração (Mantendo toda a lógica robusta)
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

    return {
        session_id: sessionId,
        company_id: companyId,
        remote_jid: remoteJid,
        from_me: fromMe,
        content: content,
        message_type: messageType,
        status: 'received',
        created_at: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : new Date().toISOString()
    };
};

// --- AUX 2: Salva Contato (COM METADATA DE GRUPO) ---
const upsertContact = async (jid, sock, pushName = null, companyId = null) => {
    try {
        const isGroup = jid.endsWith('@g.us');
        let name = pushName;
        let profilePicUrl = null;

        try {
            profilePicUrl = await sock.profilePictureUrl(jid, 'image');
        } catch (e) { /* Silencioso */ }

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
        if (companyId) contactData.company_id = companyId;

        await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
    } catch (err) {
        // Silencioso para não poluir log
    }
};

// --- AUX 3: Batch Save (SILENCIOSO E SEGURO) ---
const saveMessagesBatch = async (messages) => {
    if (!messages || messages.length === 0) return;
    
    const BATCH_SIZE = 50;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        try {
            const { error } = await supabase.from('messages').insert(batch);
            if (error) console.error("❌ ERRO DB (Msgs):", error.message);
        } catch (err) {
            console.error("❌ ERRO CRÍTICO BATCH:", err.message);
        }
    }
};

// --- CORE: Iniciar Sessão ---
export const startSession = async (sessionId, companyId) => {
    console.log(`[START] Sessão ${sessionId} (Empresa: ${companyId})`);
    
    if (sessions.has(sessionId)) {
        await deleteSession(sessionId, companyId, false);
    }

    const { state, saveCreds } = await useSupabaseAuthState(sessionId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "silent" }), // Mantém o pino mudo
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: true, 
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 2000,
    });

    sock.companyId = companyId;
    sessions.set(sessionId, sock); 
    if (companyId) companyIndex.set(companyId, sessionId);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (!sessions.has(sessionId)) return; // Trava Anti-Zumbi

        if (qr) {
            await supabase.from("instances").upsert({ 
                session_id: sessionId, qrcode_url: qr, status: "qrcode", company_id: companyId, name: "WhatsApp Principal" 
            }, { onConflict: 'session_id' });
        }

        if (connection === "close") {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect && sessions.has(sessionId)) {
                await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
                sessions.delete(sessionId);
                
                const attempt = (retries.get(sessionId) || 0) + 1;
                retries.set(sessionId, attempt);
                // Delay silencioso
                setTimeout(() => startSession(sessionId, companyId), Math.min(attempt * 2000, 10000));
            } else {
                await deleteSession(sessionId, companyId, false);
            }
        }

        if (connection === "open") {
            console.log(`[OPEN] Conectado!`);
            retries.set(sessionId, 0);
            await supabase.from("instances").update({ status: "connected", qrcode_url: null }).eq("session_id", sessionId);

            // Sync de Grupos
            try {
                const groups = await sock.groupFetchAllParticipating();
                for (const g of Object.values(groups)) {
                    await upsertContact(g.id, sock, g.subject, companyId);
                }
            } catch (e) {}
        }
    });

    // --- SYNC HISTÓRICO (CORRIGIDO ERRO DE DUPLICIDADE) ---
    sock.ev.on("messaging-history.set", async ({ messages, contacts }) => {
        // Logs removidos, apenas processamento
        const formattedMessages = messages.map(msg => extractMessageData(msg, sessionId, companyId)).filter(Boolean);
        await saveMessagesBatch(formattedMessages);

        if (contacts) {
            // DEDUPLICAÇÃO: Corrige o erro "ON CONFLICT DO UPDATE command cannot affect row a second time"
            const uniqueContacts = new Map();
            contacts.forEach(c => {
                if (!uniqueContacts.has(c.id)) {
                    uniqueContacts.set(c.id, {
                        jid: c.id,
                        name: c.name || c.notify || c.verifiedName,
                        push_name: c.notify,
                        company_id: companyId,
                        updated_at: new Date()
                    });
                }
            });

            const contactBatch = Array.from(uniqueContacts.values());
            const BATCH = 50;
            for (let i = 0; i < contactBatch.length; i += BATCH) {
                const chunk = contactBatch.slice(i, i + BATCH);
                // Upsert seguro por lotes únicos
                const { error } = await supabase.from('contacts').upsert(chunk, { onConflict: 'jid' });
                if (error) console.error("❌ Erro Contatos:", error.message);
            }
        }
    });

    sock.ev.on("contacts.upsert", async (contacts) => {
        for (const c of contacts) {
            await upsertContact(c.id, sock, c.name || c.notify, companyId);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!sessions.has(sessionId) || type !== 'notify') return;

        const formattedMessages = messages.map(msg => extractMessageData(msg, sessionId, companyId)).filter(Boolean);

        if (formattedMessages.length > 0) {
            await saveMessagesBatch(formattedMessages);
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.key.remoteJid) {
                    await upsertContact(msg.key.remoteJid, sock, msg.pushName, companyId);
                }
            }
        }
    });

    return sock;
};

// --- FUNÇÃO DELETAR (MANTIDA IGUAL) ---
export const deleteSession = async (sessionId, companyId, clearDb = true) => {
    console.log(`[DELETE] Sessão ${sessionId}`);
    if (companyId) companyIndex.delete(companyId);
    
    const sock = sessions.get(sessionId);
    sessions.delete(sessionId);
    retries.delete(sessionId);
    
    if (sock) { try { sock.end(undefined); } catch (e) {} }

    if (clearDb) {
        await supabase.from("instances").delete().eq("session_id", sessionId);
        await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);
        if (companyId) {
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

export const getSessionId = (companyId) => companyIndex.get(companyId);

export const getSession = (companyId) => {
    const sessionId = companyIndex.get(companyId);
    return sessionId ? sessions.get(sessionId) : null;
};
