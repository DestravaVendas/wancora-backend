import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } from "@whiskeysockets/baileys";
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
// NOVO: Mapa para guardar os timers de reconexão e poder cancelá-los
const reconnectTimers = new Map();      

// --- HELPER NOVO: Garante que o Lead existe (Anti-Ghost) ---
const ensureLeadExists = async (remoteJid, pushName, companyId) => {
    if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us')) return null;

    const phone = remoteJid.split('@')[0];

    const { data: existingLead } = await supabase
        .from('leads')
        .select('id')
        .eq('phone', phone) 
        .eq('company_id', companyId)
        .maybeSingle();

    if (existingLead) return existingLead.id;

    console.log(`[AUTO-LEAD] Criando lead para ${phone}...`);

    const { data: newLead, error } = await supabase
        .from('leads')
        .insert({
            company_id: companyId,
            name: pushName || `Novo Contato (${phone})`,
            phone: phone,
            status: 'new', 
            funnel_stage_id: null 
        })
        .select('id')
        .single();

    if (error) {
        console.error("[LEAD ERROR] Falha ao criar lead automático:", error.message);
        return null;
    }
    return newLead.id;
};

// --- HELPER: Determinar Tipo da Mensagem ---
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

// --- HELPER: Extrair Conteúdo ---
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
    if (msg.stickerMessage) return "[Figurinha]";

    if (msg.pollCreationMessage || msg.pollCreationMessageV3) {
        const pollData = (msg.pollCreationMessage || msg.pollCreationMessageV3);
        return JSON.stringify({
            name: pollData.name,
            options: pollData.options.map(o => o.optionName)
        });
    }

    return "";
};

// --- HELPER: Upsert Contato ---
const upsertContact = async (jid, sock, pushName = null, companyId = null) => {
    try {
        if (!jid || jid.includes('status@broadcast')) return;
        
        const cleanJid = jid.split(':')[0] + (jid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net');
        const isGroup = cleanJid.endsWith('@g.us');
        let name = pushName;
        let profilePicUrl = null;

        if (isGroup) {
            try {
                const groupMetadata = await sock.groupMetadata(cleanJid);
                name = groupMetadata.subject;
            } catch (e) {}
        }

        const contactData = {
            jid: cleanJid,
            profile_pic_url: profilePicUrl,
            updated_at: new Date()
        };
        
        if (name) {
            contactData.name = name;
            contactData.push_name = name;
        }
        if (companyId) contactData.company_id = companyId;

        await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
    } catch (err) {}
};

// ==============================================================================
// CORE: START SESSION
// ==============================================================================
export const startSession = async (sessionId, companyId) => {
    console.log(`[START] Sessão ${sessionId} (Empresa: ${companyId})`);
    
    // Garante limpeza antes de iniciar
    if (sessions.has(sessionId)) {
        await deleteSession(sessionId, companyId, false);
    }

    const { state, saveCreds } = await useSupabaseAuthState(sessionId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        printQRInTerminal: true,
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

    // --- CONEXÃO ---
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (!sessions.has(sessionId)) return; 

        if (qr) {
            await supabase.from("instances").upsert({ 
                session_id: sessionId, qrcode_url: qr, status: "qr_ready", company_id: companyId, name: "Conectando...", updated_at: new Date()
            }, { onConflict: 'session_id' });
        }

        if (connection === "close") {
            // Limpa timer anterior se existir
            if (reconnectTimers.has(sessionId)) {
                clearTimeout(reconnectTimers.get(sessionId));
                reconnectTimers.delete(sessionId);
            }

            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect && sessions.has(sessionId)) {
                await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
                
                // Limpeza Parcial (mantém sessão no mapa mas prepara reconexão)
                const attempt = (retries.get(sessionId) || 0) + 1;
                retries.set(sessionId, attempt);
                
                const delayMs = Math.min(attempt * 2000, 10000);
                console.log(`[RECONNECT] Tentativa ${attempt} em ${delayMs}ms...`);

                // FIX: Salva o ID do timeout para poder cancelar no logout
                const timeoutId = setTimeout(() => {
                    // Verifica novamente se a sessão ainda deve existir
                    if (sessions.has(sessionId)) {
                        startSession(sessionId, companyId);
                    }
                }, delayMs);
                
                reconnectTimers.set(sessionId, timeoutId);

            } else {
                await deleteSession(sessionId, companyId, false);
            }
        }

        if (connection === "open") {
            console.log(`[OPEN] Conectado!`);
            retries.set(sessionId, 0);
            
            // Limpa timers de reconexão pois conectou
            if (reconnectTimers.has(sessionId)) {
                clearTimeout(reconnectTimers.get(sessionId));
                reconnectTimers.delete(sessionId);
            }
            
            const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            let myPic = null;
            try { myPic = await sock.profilePictureUrl(userJid, 'image'); } catch(e){}

            await supabase.from("instances").update({ 
                status: "connected", qrcode_url: null, name: sock.user.name || "WhatsApp Conectado", profile_pic_url: myPic, updated_at: new Date()
            }).eq("session_id", sessionId);

            try {
                const groups = await sock.groupFetchAllParticipating();
                for (const g of Object.values(groups)) {
                    await upsertContact(g.id, sock, g.subject, companyId);
                }
            } catch (e) {}
        }
    });

    // --- PROCESSAMENTO DE MENSAGENS ---
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!sessions.has(sessionId)) return;

        if (type === "notify" || type === "append") {
            for (const msg of messages) {
                if (!msg.message) continue;
                if (msg.key.remoteJid === 'status@broadcast') continue;

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

                const { error } = await supabase.from('messages').insert({
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

                if (error) console.error("❌ Erro DB:", error.message);
            }
        }
    });

    return sock;
};

// ==============================================================================
// FUNÇÃO DE ENVIO UNIVERSAL
// ==============================================================================
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
        // Ajuste no mimetype do áudio para tentar compatibilidade
        case 'audio': msgContent = { audio: { url: payload.url }, mimetype: 'audio/mp4', ptt: payload.ptt || false }; break;
        case 'document': msgContent = { document: { url: payload.url }, mimetype: payload.mimetype || 'application/pdf', fileName: payload.fileName || 'arquivo.pdf' }; break;
        case 'poll': msgContent = { poll: { name: payload.name, values: payload.values, selectableCount: payload.selectableCount || 1 } }; break;
        default: throw new Error(`Tipo de mensagem não suportado: ${type}`);
    }

    const sent = await sock.sendMessage(jid, msgContent);
    return sent;
};

// ==============================================================================
// DELETE & GETTERS
// ==============================================================================
export const deleteSession = async (sessionId, companyId, clearDb = true) => {
    console.log(`[DELETE] Sessão ${sessionId}`);
    if (companyId) companyIndex.delete(companyId);
    
    // FIX: Cancela qualquer reconexão pendente
    if (reconnectTimers.has(sessionId)) {
        clearTimeout(reconnectTimers.get(sessionId));
        reconnectTimers.delete(sessionId);
    }

    const sock = sessions.get(sessionId);
    sessions.delete(sessionId);
    retries.delete(sessionId);
    
    if (sock) { 
        try { 
            // FIX: Remove listeners para evitar vazamento de memória
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
