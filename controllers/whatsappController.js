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

    if (error) {
        console.error("[LEAD ERROR]", error.message);
        return null;
    }
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
    console.log(`[START] Sessão ${sessionId}`);
    
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
        syncFullHistory: true, // LIGADO: Para baixar contatos e histórico
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

    // --- 1. DOWNLOAD DE HISTÓRICO INTELIGENTE ---
    // Esse evento dispara assim que conecta. Vamos salvar contatos e as últimas msgs.
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
        console.log(`[HISTÓRICO] Recebido: ${contacts.length} contatos, ${chats.length} chats.`);

        // A. Salvar Contatos (Prioridade)
        const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net'));
        if (validContacts.length > 0) {
            console.log(`[DB] Salvando ${validContacts.length} contatos...`);
            const batch = validContacts.map(c => ({
                jid: c.id,
                name: c.name || c.verifiedName || null,
                push_name: c.notify || null,
                company_id: companyId,
                updated_at: new Date()
            }));
            // Upsert em batch silencioso
            await supabase.from('contacts').upsert(batch, { onConflict: 'jid' });
        }

        // B. Salvar Últimas Mensagens (Filtro)
        // Pegamos apenas as últimas 5 mensagens para não travar o banco/render
        let messagesToSave = [];
        // O array 'messages' do Baileys já vem agrupado. Vamos tentar extrair.
        // Nota: A estrutura pode variar, vamos iterar com segurança.
        
        // Se vier muitas mensagens, processamos apenas as recentes (últimas 50 no total)
        const safeMessages = messages.slice(-50); 
        
        for (const msg of safeMessages) {
            if (!msg.message) continue;
            // Reutiliza a lógica de processamento
            await processMessage(msg, sessionId, companyId, sock);
        }
        console.log(`[HISTÓRICO] ${safeMessages.length} mensagens recentes processadas.`);
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

    // --- 3. GRUPOS ---
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

        // QR CODE (Update, não Upsert)
        if (qr) {
            const now = Date.now();
            const lastTime = lastQrUpdate.get(sessionId) || 0;
            if (now - lastTime > 800) {
                lastQrUpdate.set(sessionId, now);
                const { error } = await supabase.from("instances")
                    .update({ qrcode_url: qr, status: "qrcode", updated_at: new Date() })
                    .eq('session_id', sessionId);
                
                if (error) console.error("❌ ERRO SUPABASE QR:", error.message);
                else console.log("✅ QR Code Salvo!");
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

            setTimeout(async () => {
                 const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                 try { 
                     const myPic = await sock.profilePictureUrl(userJid, 'image'); 
                     if(myPic) await supabase.from("instances").update({ profile_pic_url: myPic }).eq("session_id", sessionId);
                 } catch(e){}

                 try {
                     const groups = await sock.groupFetchAllParticipating();
                     const groupsList = Object.values(groups);
                     for (const g of groupsList) {
                         await upsertContact(g.id, sock, null, companyId, g.subject);
                     }
                 } catch (e) {}
            }, 2000);
        }
    });

    // --- 5. RECEBIMENTO DE MENSAGENS (Notify + Append) ---
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!sessions.has(sessionId)) return;
        
        // Aceitamos 'notify' (novas) e 'append' (histórico/envio próprio)
        if (type === "notify" || type === "append") {
            for (const msg of messages) {
                await processMessage(msg, sessionId, companyId, sock);
            }
        }
    });

    return sock;
};

// --- FUNÇÃO CENTRALIZADA DE PROCESSAMENTO DE MENSAGEM ---
const processMessage = async (msg, sessionId, companyId, sock) => {
    try {
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const remoteJid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const content = getMessageContent(msg.message);
        const msgType = getMessageType(msg.message);

        // Se não tiver conteúdo legível e não for mídia, ignora
        if (!content && msgType === 'text') return;

        console.log(`[MSG] Recebida de ${remoteJid.split('@')[0]} (Eu? ${fromMe})`);

        // 1. Garante Contato
        await upsertContact(remoteJid, sock, msg.pushName, companyId);

        // 2. Garante Lead (Se não for grupo e não for eu)
        let leadId = null;
        if (!remoteJid.includes('@g.us')) {
            // Mesmo se for 'fromMe', tentamos achar o lead para vincular a mensagem
            // Se não achar, e for 'fromMe', talvez não queiramos criar Lead agora (opcional)
            // Aqui mantemos a lógica de criar apenas se recebermos msg
            if (!fromMe) {
                leadId = await ensureLeadExists(remoteJid, msg.pushName, companyId);
            } else {
                // Se eu enviei, tento achar o lead, mas não crio
                const phone = remoteJid.split('@')[0];
                const { data: lead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
                if (lead) leadId = lead.id;
            }
        }

        // 3. Salva Mensagem
        const { error } = await supabase.from('messages').insert({
            company_id: companyId,
            session_id: sessionId,
            remote_jid: remoteJid,
            from_me: fromMe,
            content: content || '[Mídia]',
            message_type: msgType,
            status: fromMe ? 'sent' : 'received',
            lead_id: leadId, 
            created_at: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date()
        });

        if (error) console.error("❌ Erro DB Msg:", error.message);

    } catch (e) {
        console.error("Erro ao processar mensagem individual:", e);
    }
};

export const sendMessage = async (sessionId, to, payload) => {
    const sock = sessions.get(sessionId);
    if (!sock) throw new Error("Sessão não ativa");
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    const sent = await sock.sendMessage(jid, { text: payload.content || payload.text || "" });
    return sent;
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
