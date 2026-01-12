import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

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

// --- HELPER 1: Anti-Ghost (Pipeline Stages - Validado) ---
const ensureLeadExists = async (remoteJid, pushName, companyId) => {
    if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us')) return null;
    const phone = remoteJid.split('@')[0];

    // 1. Tenta achar lead existente
    const { data: existingLead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
    if (existingLead) return existingLead.id;

    // 2. Busca primeira etapa do Kanban
    const { data: firstStage } = await supabase
        .from('pipeline_stages')
        .select('id')
        .eq('company_id', companyId)
        .order('position', { ascending: true })
        .limit(1)
        .maybeSingle();

    // 3. Cria novo lead
    const { data: newLead, error } = await supabase.from('leads').insert({
        company_id: companyId,
        name: pushName || `Novo Contato (${phone})`,
        phone: phone,
        status: 'new',
        pipeline_stage_id: firstStage?.id || null 
    }).select('id').single();

    if (error) {
        console.error("[LEAD ERROR] Falha ao criar lead:", error.message);
        return null;
    }
    return newLead.id;
};

// --- HELPER 2: Upsert Contato Inteligente (Nomes/Grupos) ---
const upsertContact = async (jid, sock, pushName = null, companyId = null, savedName = null, imgUrl = null) => {
    try {
        const cleanJid = jid.split(':')[0] + (jid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net');
        
        const contactData = {
            jid: cleanJid,
            company_id: companyId,
            updated_at: new Date()
        };

        // Lógica de Prioridade de Nomes
        if (savedName) contactData.name = savedName; 
        if (pushName) contactData.push_name = pushName;
        if (imgUrl) contactData.profile_pic_url = imgUrl;

        await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
    } catch (e) {
        // Silencioso
    }
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
    
    // Limpeza prévia
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
        syncFullHistory: false, // MANTIDO FALSE PARA NÃO TRAVAR
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

    // --- DOWNLOAD DE CONTATOS (Ao conectar) ---
    sock.ev.on("contacts.upsert", async (contacts) => {
        const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net'));
        if (validContacts.length > 0) {
            console.log(`[CONTATOS] Baixando ${validContacts.length} contatos...`);
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

    // --- DOWNLOAD DE GRUPOS (Ao conectar) ---
    sock.ev.on("groups.update", async (groups) => {
        for (const g of groups) {
            if (g.subject) {
                // Salva grupo: Nome do grupo vai em 'name'
                await upsertContact(g.id, sock, null, companyId, g.subject);
            }
        }
    });

    // --- EVENTOS DE CONEXÃO ---
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection) console.log(`[CONN] Sessão ${sessionId}: ${connection}`);

        if (!sessions.has(sessionId)) return; 

        // 1. QR CODE (A CORREÇÃO ESTÁ AQUI ⬇️)
        if (qr) {
            const now = Date.now();
            const lastTime = lastQrUpdate.get(sessionId) || 0;
            
            // Debounce reduzido
            if (now - lastTime > 800) {
                lastQrUpdate.set(sessionId, now);
                console.log(`[QR] Tentando salvar no Supabase...`);
                
                // MUDEI DE .upsert() PARA .update()
                // Isso evita o erro de "null name" porque ele atualiza a linha criada pelo Frontend
                const { error } = await supabase.from("instances")
                    .update({ 
                        qrcode_url: qr, 
                        status: "qrcode", 
                        updated_at: new Date()
                    })
                    .eq('session_id', sessionId); // <--- IMPORTANTE: Só atualiza onde o ID bate

                if (error) {
                    console.error("❌ ERRO SUPABASE QR:", error.message);
                } else {
                    console.log("✅ QR Code Salvo com Sucesso!");
                }
            }
        }

        // 2. DESCONEXÃO
        if (connection === "close") {
            lastQrUpdate.delete(sessionId);
            if (reconnectTimers.has(sessionId)) { clearTimeout(reconnectTimers.get(sessionId)); reconnectTimers.delete(sessionId); }

            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            
            // 401/403 = Logout manual pelo celular
            if (statusCode === 401 || statusCode === 403) {
                 console.log(`[STOP] Sessão encerrada pelo usuário.`);
                 await deleteSession(sessionId, companyId, true);
                 return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && sessions.has(sessionId)) {
                await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
                
                const attempt = (retries.get(sessionId) || 0) + 1;
                retries.set(sessionId, attempt);
                
                const delayMs = Math.min(attempt * 2000, 10000);
                console.log(`[RECONNECT] Tentativa ${attempt} em ${delayMs}ms...`);
                
                const timeoutId = setTimeout(() => { if (sessions.has(sessionId)) startSession(sessionId, companyId); }, delayMs);
                reconnectTimers.set(sessionId, timeoutId);
            } else {
                await deleteSession(sessionId, companyId, false);
            }
        }

        // 3. CONECTADO
        if (connection === "open") {
            console.log(`[OPEN] Conectado!`);
            retries.set(sessionId, 0);
            
            // Salva status conectado (SEM alterar o nome)
            await supabase.from("instances").update({ 
                status: "connected", 
                qrcode_url: null, 
                updated_at: new Date() 
            }).eq("session_id", sessionId);

            // Rotina de Pós-Conexão (Grupos e Foto)
            setTimeout(async () => {
                 const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                 
                 // Foto do Bot
                 try { 
                     const myPic = await sock.profilePictureUrl(userJid, 'image'); 
                     if(myPic) await supabase.from("instances").update({ profile_pic_url: myPic }).eq("session_id", sessionId);
                 } catch(e){}

                 // Busca Grupos Explicitamente
                 try {
                     console.log("[GRUPOS] Buscando lista de grupos...");
                     const groups = await sock.groupFetchAllParticipating();
                     const groupsList = Object.values(groups);
                     console.log(`[GRUPOS] Encontrados: ${groupsList.length}`);
                     
                     for (const g of groupsList) {
                         await upsertContact(g.id, sock, null, companyId, g.subject);
                     }
                 } catch (e) {
                     console.error("Erro ao buscar grupos:", e);
                 }
            }, 2000);
        }
    });

    // MENSAGENS (Processamento Live)
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!sessions.has(sessionId)) return;
        if (type === "notify") {
            for (const msg of messages) {
                if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

                const remoteJid = msg.key.remoteJid;
                const fromMe = msg.key.fromMe;
                const content = getMessageContent(msg.message);
                const msgType = getMessageType(msg.message);

                // Upsert com Nomes
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
                    content: content || '[Mídia]',
                    message_type: msgType,
                    status: fromMe ? 'sent' : 'received',
                    lead_id: leadId, 
                    created_at: new Date()
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
