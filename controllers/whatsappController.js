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
import mime from "mime-types"; // Necessário para extensão de arquivos

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

// --- HELPER NOVO: Upload de Mídia para Supabase Storage ---
const uploadMediaToSupabase = async (buffer, type) => {
    try {
        const fileExt = mime.extension(type) || 'bin';
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `chat-media/${fileName}`;

        // Upload
        const { error } = await supabase.storage
            .from('chat-media') // Certifique-se de ter criado este bucket "Public" no Supabase
            .upload(filePath, buffer, {
                contentType: type,
                upsert: false
            });

        if (error) throw error;

        // Get URL
        const { data } = supabase.storage
            .from('chat-media')
            .getPublicUrl(filePath);

        return data.publicUrl;
    } catch (err) {
        console.error('❌ Erro upload media:', err.message);
        return null;
    }
};

// --- HELPER 1: Anti-Ghost (Pipeline Stages) ---
const ensureLeadExists = async (remoteJid, pushName, companyId) => {
    if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us')) return null;
    const phone = remoteJid.split('@')[0];

    const { data: existingLead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
    if (existingLead) return existingLead.id;

    // Pega primeira etapa
    const { data: firstStage } = await supabase.from('pipeline_stages')
        .select('id').eq('company_id', companyId).order('position', { ascending: true }).limit(1).maybeSingle();

    // Cria lead
    const { data: newLead, error } = await supabase.from('leads').insert({
        company_id: companyId,
        name: pushName || `Novo Contato (${phone})`,
        phone: phone,
        status: 'new',
        pipeline_stage_id: firstStage?.id || null 
    }).select('id').single();

    if (error) return null;
    return newLead.id;
};

// --- HELPER 2: Upsert Contato ---
const upsertContact = async (jid, sock, pushName = null, companyId = null, savedName = null, imgUrl = null) => {
    try {
        const cleanJid = jid.split(':')[0] + (jid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net');
        
        const contactData = {
            jid: cleanJid,
            company_id: companyId,
            updated_at: new Date()
        };

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
    if (msg.pollCreationMessage) return 'poll';
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

    // --- 1. DOWNLOAD DE HISTÓRICO INTELIGENTE ---
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        console.log(`[HISTÓRICO] Recebido: ${contacts.length} contatos, ${messages.length} mensagens.`);

        // A. Salvar Contatos
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

        // B. Salvar Últimas Mensagens (Sem baixar mídia pesada para não travar o boot)
        const safeMessages = messages.slice(-50); 
        for (const msg of safeMessages) {
            // Passamos false no final para indicar que é histórico e não precisa baixar mídia agora
            await processMessage(msg, sessionId, companyId, sock, false); 
        }
    });

    // --- 2. ATUALIZAÇÃO DE CONTATOS ---
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

    // --- 3. GRUPOS (Mantido da sua versão robusta) ---
    sock.ev.on("groups.update", async (groups) => {
        for (const g of groups) {
            if (g.subject) {
                await upsertContact(g.id, sock, null, companyId, g.subject);
            }
        }
    });

    // --- 4. CONEXÃO ---
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection) console.log(`[CONN] Sessão ${sessionId}: ${connection}`);

        if (!sessions.has(sessionId)) return; 

        if (qr) {
            const now = Date.now();
            const lastTime = lastQrUpdate.get(sessionId) || 0;
            if (now - lastTime > 800) {
                lastQrUpdate.set(sessionId, now);
                await supabase.from("instances")
                    .update({ qrcode_url: qr, status: "qrcode", updated_at: new Date() })
                    .eq('session_id', sessionId);
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
            console.log(`[OPEN] Conectado!`);
            retries.set(sessionId, 0);
            
            await supabase.from("instances").update({ status: "connected", qrcode_url: null, updated_at: new Date() }).eq("session_id", sessionId);

            // Tenta pegar foto do perfil da instância
            setTimeout(async () => {
                 const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                 try { 
                     const myPic = await sock.profilePictureUrl(userJid, 'image'); 
                     if(myPic) await supabase.from("instances").update({ profile_pic_url: myPic }).eq("session_id", sessionId);
                 } catch(e){}
            }, 2000);
        }
    });

    // --- 5. RECEBIMENTO DE MENSAGENS (REALTIME) ---
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!sessions.has(sessionId)) return;
        
        // 'notify' é mensagem nova chegando em tempo real
        // 'append' é mensagem enviada por outro dispositivo (sincronização)
        if (type === "notify" || type === "append") {
            for (const msg of messages) {
                // Passamos true para fazer o download da mídia aqui (TEMPO REAL)
                await processMessage(msg, sessionId, companyId, sock, true);
            }
        }
    });

    return sock;
};

// --- PROCESSAMENTO INTELIGENTE (COM FILTRO DE LID E MÍDIA) ---
const processMessage = async (msg, sessionId, companyId, sock, shouldDownloadMedia = false) => {
    try {
        // 1. FILTRO DE SEGURANÇA: Ignora Status, Broadcasts e LIDs (Ids técnicos do WhatsApp)
        if (!msg.message) return;
        if (msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.remoteJid.includes('@lid')) return; // <--- NOVA PROTEÇÃO CONTRA O ERRO FK
        if (msg.key.remoteJid.includes('@broadcast')) return;

        const remoteJid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const whatsappId = msg.key.id; 
        const pushName = msg.pushName;
        
        let content = getMessageContent(msg.message);
        let msgType = getMessageType(msg.message);
        let mediaUrl = null;

        // Se for texto vazio e não tem mídia, ignora
        if (!content && msgType === 'text') return;

        console.log(`[MSG] Recebida de ${remoteJid} (${msgType})`);

        // 2. Garante Contato (Normaliza para @s.whatsapp.net)
        await upsertContact(remoteJid, sock, pushName, companyId);

        // 3. Garante Lead (Se não for grupo)
        let leadId = null;
        if (!remoteJid.includes('@g.us')) {
            if (!fromMe) {
                leadId = await ensureLeadExists(remoteJid, pushName, companyId);
            } else {
                const phone = remoteJid.split('@')[0];
                const { data: lead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
                if (lead) leadId = lead.id;
            }
        }

        // 4. Download de Mídia (Apenas se solicitado e for tipo mídia)
        if (shouldDownloadMedia && ['image', 'video', 'audio', 'document'].includes(msgType)) {
            try {
                // Faz o download do binário usando a função do Baileys
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                
                // Determina MimeType para salvar corretamente
                let mimetype = 'application/octet-stream';
                if (msg.message.imageMessage) mimetype = 'image/jpeg';
                else if (msg.message.audioMessage) mimetype = 'audio/mp4'; 
                else if (msg.message.videoMessage) mimetype = 'video/mp4';
                else if (msg.message.documentMessage) mimetype = msg.message.documentMessage.mimetype;

                // Sobe para o Supabase e pega a URL
                mediaUrl = await uploadMediaToSupabase(buffer, mimetype);
                if (mediaUrl) console.log(`[MEDIA] Upload concluído: ${mediaUrl}`);
            } catch (mediaErr) {
                console.error('[MEDIA] Falha no download (Ignorando):', mediaErr.message);
            }
        }

        // 5. Salva Mensagem
        const { error } = await supabase.from('messages').upsert({
            company_id: companyId,
            session_id: sessionId,
            remote_jid: remoteJid, // Agora temos certeza que é um JID válido (@s.whatsapp.net ou @g.us)
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

        if (error) console.error("❌ Erro DB Msg:", error.message);

    } catch (e) {
        console.error("Erro processamento msg:", e);
    }
};

// --- ENVIO (COM SUPORTE A MULTIMÍDIA) ---
export const sendMessage = async (sessionId, to, payload) => {
    const sock = sessions.get(sessionId);
    if (!sock) throw new Error("Sessão não ativa");
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    let sentMsg;

    try {
        if (payload.type === 'text') {
            sentMsg = await sock.sendMessage(jid, { text: payload.content || payload.text || "" });
        } 
        else if (payload.type === 'image') {
            sentMsg = await sock.sendMessage(jid, { 
                image: { url: payload.url }, 
                caption: payload.caption 
            });
        }
        else if (payload.type === 'video') {
            sentMsg = await sock.sendMessage(jid, { 
                video: { url: payload.url }, 
                caption: payload.caption 
            });
        }
        else if (payload.type === 'audio') {
            sentMsg = await sock.sendMessage(jid, { 
                audio: { url: payload.url }, 
                mimetype: 'audio/mp4',
                ptt: payload.ptt || false // Se true, envia como nota de voz
            });
        }
        else if (payload.type === 'document') {
            sentMsg = await sock.sendMessage(jid, { 
                document: { url: payload.url }, 
                mimetype: payload.mimetype || 'application/pdf',
                fileName: payload.fileName || 'documento'
            });
        }
        else if (payload.type === 'poll') {
             sentMsg = await sock.sendMessage(jid, {
                poll: {
                    name: payload.name,
                    values: payload.options,
                    selectableCount: 1
                }
            });
        }

        return sentMsg;
    } catch (err) {
        console.error("Erro no envio:", err);
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
