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

// --- HELPER: Anti-Ghost (CORRIGIDO PARA SEU BANCO: pipeline_stages) ---
const ensureLeadExists = async (remoteJid, pushName, companyId) => {
    if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us')) return null;
    const phone = remoteJid.split('@')[0];

    // 1. Tenta achar lead existente
    const { data: existingLead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
    if (existingLead) return existingLead.id;

    // 2. Busca a primeira etapa do Kanban na tabela PIPELINE_STAGES
    const { data: firstStage } = await supabase
        .from('pipeline_stages')
        .select('id')
        .eq('company_id', companyId)
        .order('position', { ascending: true })
        .limit(1)
        .maybeSingle();

    console.log(`[AUTO-LEAD] Criando lead para ${phone}...`);
    
    // 3. Cria novo lead (usando pipeline_stage_id)
    const { data: newLead, error } = await supabase.from('leads').insert({
        company_id: companyId,
        name: pushName || `Novo Contato (${phone})`,
        phone: phone,
        status: 'new',
        pipeline_stage_id: firstStage?.id || null // <--- CORRIGIDO AQUI
    }).select('id').single();

    if (error) {
        console.error("[LEAD ERROR] Falha ao criar lead:", error.message);
        return null;
    }
    return newLead.id;
};

// --- HELPER: Upsert Contato ---
const upsertContact = async (jid, sock, pushName = null, companyId = null) => {
    try {
        const cleanJid = jid.split(':')[0] + (jid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net');
        
        const contactData = {
            jid: cleanJid,
            name: pushName,
            company_id: companyId,
            updated_at: new Date()
        };

        // Salva contato sem travar
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
    if (msg.videoMessage) return 'video';
    if (msg.audioMessage) return 'audio';
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
        printQRInTerminal: true,
        logger: pino({ level: "silent" }),
        browser: ["Wancora CRM", "Chrome", "10.0"],
        syncFullHistory: false, // CRÍTICO: Mantém false para não derrubar o Render
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

    // --- SINCRONIZA CONTATOS (Sem Mensagens) ---
    // Isso atende seu pedido de baixar contatos sem travar
    sock.ev.on("contacts.upsert", async (contacts) => {
        const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net'));
        
        if (validContacts.length > 0) {
            console.log(`[CONTATOS] Sincronizando ${validContacts.length} contatos...`);
            
            // Processa em lote para ser rápido
            const batch = validContacts.map(c => ({
                jid: c.id,
                name: c.name || c.notify || c.verifiedName || null,
                company_id: companyId,
                updated_at: new Date()
            }));

            const { error } = await supabase.from('contacts').upsert(batch, { onConflict: 'jid' });
            if(error) console.error("Erro ao salvar contatos:", error.message);
        }
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection) console.log(`[CONN] Sessão ${sessionId}: ${connection}`);

        if (!sessions.has(sessionId)) return; 

        // 1. QR CODE
        if (qr) {
            const now = Date.now();
            const lastTime = lastQrUpdate.get(sessionId) || 0;
            if (now - lastTime > 2000) {
                lastQrUpdate.set(sessionId, now);
                console.log(`[QR] Atualizando no banco...`);
                // CORREÇÃO DE NOME: Não enviamos 'name' aqui para não sobrescrever
                await supabase.from("instances").upsert({ 
                    session_id: sessionId, 
                    qrcode_url: qr, 
                    status: "qr_ready", 
                    company_id: companyId, 
                    updated_at: new Date()
                }, { onConflict: 'session_id' });
            }
        }

        // 2. CONEXÃO FECHADA
        if (connection === "close") {
            lastQrUpdate.delete(sessionId);
            if (reconnectTimers.has(sessionId)) { clearTimeout(reconnectTimers.get(sessionId)); reconnectTimers.delete(sessionId); }

            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            
            // 401/403: Desconectado pelo celular -> Para de tentar
            if (statusCode === 401 || statusCode === 403) {
                 console.log(`[STOP] Desconectado pelo usuário.`);
                 await deleteSession(sessionId, companyId, true);
                 return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && sessions.has(sessionId)) {
                await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
                
                const attempt = (retries.get(sessionId) || 0) + 1;
                retries.set(sessionId, attempt);
                const delayMs = Math.min(attempt * 3000, 15000);
                
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
            
            // CORREÇÃO DE NOME: Não enviamos 'name' para preservar o que você digitou
            await supabase.from("instances").update({ 
                status: "connected", 
                qrcode_url: null, 
                updated_at: new Date() 
            }).eq("session_id", sessionId);

            // Foto de perfil
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

                // Garante que o contato exista
                await upsertContact(remoteJid, sock, msg.pushName, companyId);

                // Garante que o Lead exista (usando pipeline_stages agora)
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
                    created_at: new Date() // Usa data atual para novas mensagens
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
            sock.ev.removeAllListeners("contacts.upsert"); // Limpa listener de contatos
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
