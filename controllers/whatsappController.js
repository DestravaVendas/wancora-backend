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

// --- HELPER 1: Determinar Tipo da Mensagem ---
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

// --- HELPER 2: Extrair Conteúdo (Texto, Caption ou JSON de Enquete) ---
const getMessageContent = (msg) => {
    if (!msg) return "";
    
    // Texto Simples
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    
    // Mídias com Legenda
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;
    
    // Se for mídia sem legenda, retorna identificador
    if (msg.imageMessage) return "[Imagem]";
    if (msg.videoMessage) return "[Vídeo]";
    if (msg.audioMessage) return "[Áudio]";
    if (msg.documentMessage) return msg.documentMessage.fileName || "[Documento]";
    if (msg.stickerMessage) return "[Figurinha]";

    // Enquete (Salva as opções como texto JSON para o frontend ler depois)
    if (msg.pollCreationMessage || msg.pollCreationMessageV3) {
        const pollData = (msg.pollCreationMessage || msg.pollCreationMessageV3);
        return JSON.stringify({
            name: pollData.name,
            options: pollData.options.map(o => o.optionName)
        });
    }

    return "";
};

// --- HELPER 3: Upsert Contato Inteligente ---
const upsertContact = async (jid, sock, pushName = null, companyId = null) => {
    try {
        if (!jid || jid.includes('status@broadcast')) return;
        
        // Remove sufixos de dispositivo para garantir ID limpo
        const cleanJid = jid.split(':')[0] + (jid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net');

        const isGroup = cleanJid.endsWith('@g.us');
        let name = pushName;
        let profilePicUrl = null;

        // Tenta pegar foto (pode falhar por privacidade)
        try {
            // profilePicUrl = await sock.profilePictureUrl(cleanJid, 'image'); // Opcional: Descomente se quiser fotos (consome banda)
        } catch (e) {}

        // Se for grupo, força pegar o nome atualizado
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
        
        // Só atualiza nome se tiver um novo (não sobrescreve com null)
        if (name) {
            contactData.name = name;
            contactData.push_name = name;
        }
        if (companyId) contactData.company_id = companyId;

        await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
    } catch (err) {
        // Silencioso
    }
};

// --- HELPER 4: Salvar Mensagem no Banco ---
const saveMessageToDb = async (msgInfo) => {
    const { error } = await supabase.from('messages').insert(msgInfo);
    if (error) console.error("❌ Erro DB:", error.message);
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
        getMessage: async (key) => {
            // Necessário para re-envio em algumas situações
            return { conversation: "hello" };
        }
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
                session_id: sessionId, qrcode_url: qr, status: "qrcode", company_id: companyId, name: "Conectando...", updated_at: new Date()
            }, { onConflict: 'session_id' });
        }

        if (connection === "close") {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && sessions.has(sessionId)) {
                await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
                sessions.delete(sessionId);
                const attempt = (retries.get(sessionId) || 0) + 1;
                retries.set(sessionId, attempt);
                setTimeout(() => startSession(sessionId, companyId), Math.min(attempt * 2000, 10000));
            } else {
                await deleteSession(sessionId, companyId, false);
            }
        }

        if (connection === "open") {
            console.log(`[OPEN] Conectado!`);
            retries.set(sessionId, 0);
            
            const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            let myPic = null;
            try { myPic = await sock.profilePictureUrl(userJid, 'image'); } catch(e){}

            await supabase.from("instances").update({ 
                status: "connected", qrcode_url: null, name: sock.user.name || "WhatsApp Conectado", profile_pic_url: myPic, updated_at: new Date()
            }).eq("session_id", sessionId);

            // Sync Grupos Inicial
            try {
                const groups = await sock.groupFetchAllParticipating();
                for (const g of Object.values(groups)) {
                    await upsertContact(g.id, sock, g.subject, companyId);
                }
            } catch (e) {}
        }
    });

    // --- PROCESSAMENTO DE MENSAGENS (TEXTO, MÍDIA, ENQUETES) ---
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

                // 1. Garante Contato
                await upsertContact(remoteJid, sock, msg.pushName, companyId);

                // 2. Salva Mensagem
                await saveMessageToDb({
                    company_id: companyId,
                    session_id: sessionId,
                    remote_jid: remoteJid,
                    from_me: fromMe,
                    content: content,
                    message_type: msgType,
                    status: fromMe ? 'sent' : 'received',
                    created_at: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date()
                });
            }
        }
    });

    return sock;
};

// ==============================================================================
// FUNÇÃO DE ENVIO UNIVERSAL (Texto, Imagem, Áudio, Doc, Enquete)
// ==============================================================================
export const sendMessage = async (sessionId, to, payload) => {
    const sock = sessions.get(sessionId);
    if (!sock) throw new Error("Sessão não ativa");
    
    // Normaliza JID
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    
    // Payload pode ser string (texto simples) ou objeto (mídia/enquete)
    // Formatos esperados no payload:
    // Texto: { type: 'text', content: 'Olá' }
    // Imagem: { type: 'image', url: 'https://...', caption: 'Olha isso' }
    // Áudio: { type: 'audio', url: 'https://...', ptt: true }  (ptt=true manda como nota de voz)
    // Doc: { type: 'document', url: 'https://...', fileName: 'contrato.pdf' }
    // Enquete: { type: 'poll', name: 'Qual sua cor?', values: ['Azul', 'Vermelho'], selectableCount: 1 }

    const type = payload.type || 'text';
    let msgContent = {};

    switch (type) {
        case 'text':
            msgContent = { text: payload.content };
            break;
            
        case 'image':
            msgContent = { image: { url: payload.url }, caption: payload.caption || '' };
            break;

        case 'video':
            msgContent = { video: { url: payload.url }, caption: payload.caption || '' };
            break;

        case 'audio':
            // ptt: true faz aparecer como "nota de voz" (aquele microfone azul)
            msgContent = { audio: { url: payload.url }, mimetype: 'audio/mp4', ptt: payload.ptt || false };
            break;

        case 'document':
            msgContent = { 
                document: { url: payload.url }, 
                mimetype: payload.mimetype || 'application/pdf', 
                fileName: payload.fileName || 'arquivo.pdf' 
            };
            break;

        case 'poll':
            msgContent = {
                poll: {
                    name: payload.name,
                    values: payload.values, // Array de strings ['Opção 1', 'Opção 2']
                    selectableCount: payload.selectableCount || 1
                }
            };
            break;

        default:
            throw new Error(`Tipo de mensagem não suportado: ${type}`);
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
    
    const sock = sessions.get(sessionId);
    sessions.delete(sessionId);
    retries.delete(sessionId);
    
    if (sock) { try { sock.end(undefined); } catch (e) {} }

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
