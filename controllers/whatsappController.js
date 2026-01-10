import makeWASocket, { DisconnectReason, Browsers, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// 1. CHECAGEM DE SEGURANÇA (INFRAESTRUTURA)
if (!process.env.SUPABASE_KEY || !process.env.SUPABASE_URL) {
    console.error("❌ ERRO FATAL: Chaves do Supabase não encontradas no .env");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- ARQUITETURA DE MEMÓRIA ---
const sessions = new Map();      // Mapa: sessionId -> Socket
const companyIndex = new Map();  // Mapa: companyId -> sessionId
const retries = new Map();       // Mapa: sessionId -> Tentativas de reconexão

// --- FUNÇÃO AUXILIAR 1: Extrai dados da mensagem (COM LOGICA COMPLETA) ---
const extractMessageData = (msg, sessionId, companyId) => {
    if (!msg.message) return null;
    if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return null;

    let remoteJid = msg.key.remoteJid;
    
    // Normalização de JID (Remove sufixos de device :1, :2...)
    if (remoteJid.includes(':')) {
        remoteJid = remoteJid.split(':')[0] + '@s.whatsapp.net';
    }
    
    // Ignora Status (Stories) e Broadcasts
    if (remoteJid === 'status@broadcast' || remoteJid.includes('@broadcast')) return null;

    const fromMe = msg.key.fromMe;
    
    let content = "";
    let messageType = "text";
    const m = msg.message;

    // Prioridade de Extração
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
        company_id: companyId, // VITAL: Sem isso o frontend não acha a mensagem
        remote_jid: remoteJid,
        from_me: fromMe,
        content: content,
        message_type: messageType,
        status: 'received',
        created_at: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : new Date().toISOString()
    };
};

// --- FUNÇÃO AUXILIAR 2: Salva Contato Unitário (Com Metadata de Grupo) ---
const upsertContact = async (jid, sock, pushName = null, companyId = null) => {
    try {
        const isGroup = jid.endsWith('@g.us');
        let name = pushName;
        let profilePicUrl = null;

        // 1. Tenta pegar foto (pode falhar por privacidade)
        try {
            profilePicUrl = await sock.profilePictureUrl(jid, 'image');
        } catch (e) { /* Silencioso */ }

        // 2. Se for grupo e não tiver nome, busca metadata
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

        const { error } = await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
        
        if (error) {
             console.error(`[CONTACT ERROR] Falha ao salvar ${jid}:`, error.message);
        }

    } catch (err) {
        console.error(`[CONTACT FATAL] ${err.message}`);
    }
};

// --- FUNÇÃO AUXILIAR 3: Salva Mensagens em Lote (Batch) ---
const saveMessagesBatch = async (messages) => {
    if (!messages || messages.length === 0) return;
    
    const BATCH_SIZE = 50;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        try {
            // Usamos .select() para confirmar se inseriu e ver erros detalhados
            const { error } = await supabase.from('messages').insert(batch).select();
            
            if (error) {
                console.error("❌ ERRO SUPABASE (BATCH MESSAGES):", JSON.stringify(error, null, 2));
            } else {
                console.log(`✅ [DB] ${batch.length} mensagens salvas.`);
            }
        } catch (err) {
            console.error("❌ ERRO CRÍTICO NO BATCH:", err.message);
        }
    }
};

// --- CORE: Iniciar Sessão ---
export const startSession = async (sessionId, companyId) => {
    console.log(`[START] Iniciando sessão para empresa: ${companyId}`);
    
    // Limpeza de processos anteriores
    if (sessions.has(sessionId)) {
        await deleteSession(sessionId, companyId, false);
    }

    const { state, saveCreds } = await useSupabaseAuthState(sessionId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "silent" }),
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

        // 🛡️ TRAVA ANTI-ZUMBI 1: Se a sessão foi deletada do mapa, ignora tudo.
        if (!sessions.has(sessionId)) return;

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
            
            // 🛡️ TRAVA ANTI-ZUMBI 2: Só reconecta se a sessão AINDA existir no mapa
            if (shouldReconnect && sessions.has(sessionId)) {
                await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
                
                // Remove do mapa temporariamente para evitar loops rápidos (Debounce)
                sessions.delete(sessionId);
                
                const attempt = (retries.get(sessionId) || 0) + 1;
                retries.set(sessionId, attempt);
                
                const delay = Math.min(attempt * 2000, 10000);
                console.log(`[RECONNECT] Tentativa ${attempt} em ${delay}ms...`);
                
                setTimeout(() => startSession(sessionId, companyId), delay);
            } else {
                // Logout intencional ou erro fatal -> Limpeza completa
                await deleteSession(sessionId, companyId, false);
            }
        }

        if (connection === "open") {
            console.log(`[OPEN] Conectado! Baixando histórico...`);
            retries.set(sessionId, 0);
            await supabase.from("instances").update({ status: "connected", qrcode_url: null }).eq("session_id", sessionId);

            // Sync Inicial de Grupos (Garante que nomes de grupos apareçam)
            try {
                const groups = await sock.groupFetchAllParticipating();
                for (const g of Object.values(groups)) {
                    await upsertContact(g.id, sock, g.subject, companyId);
                }
            } catch (e) {}
        }
    });

    // --- EVENTOS DE HISTÓRICO (SYNC INICIAL) ---
    sock.ev.on("messaging-history.set", async ({ messages, contacts }) => {
        console.log(`[HISTORY] Recebido: ${messages.length} msgs, ${contacts?.length || 0} contatos.`);
        
        // 1. Salva Mensagens
        const formattedMessages = messages.map(msg => extractMessageData(msg, sessionId, companyId)).filter(Boolean);
        await saveMessagesBatch(formattedMessages);

        // 2. Salva Contatos em LOTE (Melhor performance que um por um)
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
                const chunk = contactBatch.slice(i, i + BATCH);
                const { error } = await supabase.from('contacts').upsert(chunk, { onConflict: 'jid' });
                if (error) console.error("Erro no batch de contatos:", error.message);
            }
        }
    });

    // --- EVENTOS DE ATUALIZAÇÃO DE CONTATOS ---
    sock.ev.on("contacts.upsert", async (contacts) => {
        for (const c of contacts) {
            await upsertContact(c.id, sock, c.name || c.notify, companyId);
        }
    });

    // --- EVENTOS DE MENSAGENS EM TEMPO REAL ---
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        // 🛡️ TRAVA ANTI-ZUMBI 3
        if (!sessions.has(sessionId)) return;
        if (type !== 'notify') return;

        const formattedMessages = messages.map(msg => extractMessageData(msg, sessionId, companyId)).filter(Boolean);

        if (formattedMessages.length > 0) {
            console.log(`[MSG] Nova mensagem recebida. Salvando...`);
            await saveMessagesBatch(formattedMessages);
            
            // Atualiza o contato do remetente na hora
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.key.remoteJid) {
                    await upsertContact(msg.key.remoteJid, sock, msg.pushName, companyId);
                }
            }
        }
    });

    return sock;
};

// --- FUNÇÃO DE DELETAR (ANTI-ZUMBI) ---
export const deleteSession = async (sessionId, companyId, clearDb = true) => {
    console.log(`[DELETE] Matando sessão ${sessionId}`);
    
    // 1. Remove do Indexador
    if (companyId) companyIndex.delete(companyId);
    
    // 2. Pega o socket ANTES de deletar
    const sock = sessions.get(sessionId);
    
    // 3. Deleta do Mapa (Isso ativa as travas nos eventos)
    sessions.delete(sessionId);
    retries.delete(sessionId);
    
    // 4. Encerra o Socket
    if (sock) { 
        try { sock.end(undefined); } catch (e) {} 
    }

    if (clearDb) {
        // Limpa auth e instâncias
        await supabase.from("instances").delete().eq("session_id", sessionId);
        await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);
        
        // Limpeza Total (Factory Reset)
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

export const getSessionId = (companyId) => companyIndex.get(companyId);

export const getSession = (companyId) => {
    const sessionId = companyIndex.get(companyId);
    return sessionId ? sessions.get(sessionId) : null;
};
