import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

if (!process.env.SUPABASE_KEY || !process.env.SUPABASE_URL) {
    console.error("❌ ERRO FATAL: Chaves do Supabase não encontradas no .env");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const sessions = new Map();      
const companyIndex = new Map();  
const retries = new Map(); 
const reconnectTimers = new Map();      
const lastQrUpdate = new Map(); 

// --- HELPER NOVO: Anti-Ghost ---
const ensureLeadExists = async (remoteJid, pushName, companyId) => {
    if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us')) return null;
    const phone = remoteJid.split('@')[0];

    const { data: existingLead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
    if (existingLead) return existingLead.id;

    console.log(`[AUTO-LEAD] Criando lead para ${phone}...`);
    const { data: newLead, error } = await supabase.from('leads').insert({
        company_id: companyId,
        name: pushName || `Novo Contato (${phone})`,
        phone: phone,
        status: 'new', 
        funnel_stage_id: null 
    }).select('id').single();

    if (error) {
        console.error("[LEAD ERROR] Falha ao criar lead:", error.message);
        return null;
    }
    return newLead.id;
};

//Helpers de Conteúdo (Mantidos iguais ao seu arquivo)
const getMessageType = (msg) => {
    if (msg.imageMessage) return 'image';
    if (msg.videoMessage) return 'video';
    if (msg.audioMessage) return 'audio';
    if (msg.documentMessage) return 'document';
    if (msg.stickerMessage) return 'sticker';
    if (msg.locationMessage) return 'location';
    if (msg.pollCreationMessage || msg.pollCreationMessageV3) return 'poll';
    return 'text';
};

const getMessageContent = (msg) => {
    if (!msg) return "";
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;
    if (msg.imageMessage) return "[Imagem]";
    if (msg.videoMessage) return "[Vídeo]";
    if (msg.audioMessage) return "[Áudio]";
    if (msg.documentMessage) return msg.documentMessage.fileName || "[Documento]";
    if (msg.pollCreationMessage || msg.pollCreationMessageV3) {
        const pollData = (msg.pollCreationMessage || msg.pollCreationMessageV3);
        return JSON.stringify({
            name: pollData.name,
            options: pollData.options.map(o => o.optionName)
        });
    }
    return "";
};

const upsertContact = async (jid, sock, pushName = null, companyId = null) => {
    try {
        if (!jid || jid.includes('status@broadcast')) return;
        const cleanJid = jid.split(':')[0] + (jid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net');
        const isGroup = cleanJid.endsWith('@g.us');
        let name = pushName;
        
        if (isGroup) {
            try {
                const groupMetadata = await sock.groupMetadata(cleanJid);
                name = groupMetadata.subject;
            } catch (e) {}
        }

        const contactData = {
            jid: cleanJid,
            updated_at: new Date(),
            company_id: companyId
        };
        if (name) { contactData.name = name; contactData.push_name = name; }

        await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
    } catch (err) {}
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
    try {
        const v = await fetchLatestBaileysVersion();
        version = v.version;
    } catch (e) {
        console.log("[AVISO] Falha na versão, usando fallback estável.");
    }

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        printQRInTerminal: true,
        logger: pino({ level: "silent" }),
        browser: ["Wancora CRM", "Chrome", "10.0"],
        syncFullHistory: false, 
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 30000,
        generateHighQualityLinkPreview: false,
    });

    sock.companyId = companyId;
    sessions.set(sessionId, sock); 
    if (companyId) companyIndex.set(companyId, sessionId);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection) console.log(`[CONN] Sessão ${sessionId}: ${connection}`);

        if (!sessions.has(sessionId)) return; 

        // 1. QR CODE (Com Debounce)
        if (qr) {
            const now = Date.now();
            const lastTime = lastQrUpdate.get(sessionId) || 0;
            if (now - lastTime > 2000) {
                lastQrUpdate.set(sessionId, now);
                console.log(`[QR] Atualizando no banco...`);
                await supabase.from("instances").upsert({ 
                    session_id: sessionId, 
                    qrcode_url: qr, 
                    status: "qr_ready", 
                    company_id: companyId, 
                    name: "Aguardando Leitura...", 
                    updated_at: new Date()
                }, { onConflict: 'session_id' });
            }
        }

        // 2. CONEXÃO FECHADA
        if (connection === "close") {
            lastQrUpdate.delete(sessionId);
            if (reconnectTimers.has(sessionId)) {
                clearTimeout(reconnectTimers.get(sessionId));
                reconnectTimers.delete(sessionId);
            }

            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            
            // 🛑 SE FOR 401 (Deslogado), NÃO RECONECTA
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                 console.log(`[STOP] Sessão ${sessionId} desconectada permanentemente.`);
                 await deleteSession(sessionId, companyId, true);
                 return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect && sessions.has(sessionId)) {
                await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
                
                const attempt = (retries.get(sessionId) || 0) + 1;
                retries.set(sessionId, attempt);
                
                const delayMs = Math.min(attempt * 3000, 15000); // Aumentei o delay para segurança
                console.log(`[RECONNECT] Tentativa ${attempt} em ${delayMs}ms...`);

                const timeoutId = setTimeout(() => {
                    if (sessions.has(sessionId)) startSession(sessionId, companyId);
                }, delayMs);
                reconnectTimers.set(sessionId, timeoutId);
            } else {
                await deleteSession(sessionId, companyId, false);
            }
        }

        // 3. CONECTADO
        if (connection === "open") {
            console.log(`[OPEN] Conectado!`);
            retries.set(sessionId, 0);
            
            // Salva status CONECTADO
            await supabase.from("instances").update({ 
                status: "connected", 
                qrcode_url: null, 
                // name: sock.user.name || "WhatsApp Conectado", // Removido para evitar sobrescrever seu nome personalizado
                updated_at: new Date()
            }).eq("session_id", sessionId);

            // Tenta pegar a foto em background sem pressa
            setTimeout(async () => {
                 const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                 try { 
                     const myPic = await sock.profilePictureUrl(userJid, 'image'); 
                     if(myPic) await supabase.from("instances").update({ profile_pic_url: myPic }).eq("session_id", sessionId);
                 } catch(e){}
            }, 2000);
        }
    });

    // MENSAGENS (Multimídia + Anti-Ghost)
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!sessions.has(sessionId)) return;
        if (type === "notify") {
            for (const msg of messages) {
                if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

                const remoteJid = msg.key.remoteJid;
                const fromMe = msg.key.fromMe;
                const content = getMessageContent(msg.message);
                const msgType = getMessageType(msg.message);

                if (!content && msgType === 'text') continue;

                await upsertContact(remoteJid, sock, msg.pushName, companyId);

                let leadId = null;
                if (!fromMe && !remoteJid.includes('@g.us')) {
                    leadId = await ensureLeadExists(remoteJid, msg.pushName, companyId);
                }

                await supabase.from('messages').insert({
                    company_id: companyId,
                    session_id: sessionId,
                    remote_jid: remoteJid,
                    from_me: fromMe,
                    content: content,
                    message_type: msgType,
                    status: fromMe ? 'sent' : 'received',
                    lead_id: leadId, 
                    created_at: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date()
                });
            }
        }
    });

    return sock;
};

export const sendMessage = async (sessionId, to, payload) => {
    const sock = sessions.get(sessionId);
    if (!sock) throw new Error("Sessão não ativa");
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    const type = payload.type || 'text';
    let msgContent = {};

    switch (type) {
        case 'text': msgContent = { text: payload.content }; break;
        case 'image': msgContent = { image: { url: payload.url }, caption: payload.caption || '' }; break;
        case 'video': msgContent = { video: { url: payload.url }, caption: payload.caption || '' }; break;
        case 'audio': msgContent = { audio: { url: payload.url }, mimetype: 'audio/mp4', ptt: payload.ptt || false }; break;
        case 'document': msgContent = { document: { url: payload.url }, mimetype: payload.mimetype || 'application/pdf', fileName: payload.fileName || 'arquivo.pdf' }; break;
        case 'poll': msgContent = { poll: { name: payload.name, values: payload.values, selectableCount: payload.selectableCount || 1 } }; break;
        default: throw new Error(`Tipo de mensagem não suportado: ${type}`);
    }

    const sent = await sock.sendMessage(jid, msgContent);
    return sent;
};

export const deleteSession = async (sessionId, companyId, clearDb = true) => {
    console.log(`[DELETE] Sessão ${sessionId}`);
    if (companyId) companyIndex.delete(companyId);
    
    lastQrUpdate.delete(sessionId);
    if (reconnectTimers.has(sessionId)) {
        clearTimeout(reconnectTimers.get(sessionId));
        reconnectTimers.delete(sessionId);
    }

    const sock = sessions.get(sessionId);
    sessions.delete(sessionId);
    retries.delete(sessionId);
    
    if (sock) { 
        try { 
            sock.ev.removeAllListeners("connection.update");
            sock.ev.removeAllListeners("creds.update");
            sock.ev.removeAllListeners("messages.upsert");
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
