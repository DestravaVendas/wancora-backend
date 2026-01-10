import makeWASocket, { DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- ARQUITETURA DE MEMÓRIA ---
// Mapa Principal: sessionId -> Socket (Para uso interno do Baileys)
const sessions = new Map();
// Mapa Auxiliar: companyId -> sessionId (Para lookup rápido via API/Workers)
const companyIndex = new Map(); 

// --- FUNÇÃO AUXILIAR 1: Extrai dados úteis da mensagem ---
const extractMessageData = (msg, sessionId) => {
    if (!msg.message) return null;
    if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return null;

    const remoteJid = msg.key.remoteJid;
    if (remoteJid.includes('@broadcast') || remoteJid.includes('@g.us')) return null;

    const fromMe = msg.key.fromMe;
    
    const content = 
        msg.message.conversation || 
        msg.message.extendedTextMessage?.text || 
        msg.message.imageMessage?.caption || 
        msg.message.videoMessage?.caption ||
        (msg.message.imageMessage ? "[Imagem]" : null) ||
        (msg.message.audioMessage ? "[Áudio]" : null) ||
        (msg.message.stickerMessage ? "[Figurinha]" : null) ||
        "";

    if (!content) return null;

    const messageTimestamp = msg.messageTimestamp 
        ? new Date(msg.messageTimestamp * 1000).toISOString() 
        : new Date().toISOString();

    return {
        session_id: sessionId,
        remote_jid: remoteJid,
        from_me: fromMe,
        content: content,
        message_type: 'text',
        status: 'received',
        created_at: messageTimestamp
    };
};

// --- FUNÇÃO AUXILIAR 2: Salva mensagens em lote (Batch) ---
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

// --- FUNÇÃO AUXILIAR 3: Salva Contato e Foto (Upsert) ---
const upsertContact = async (jid, sock, pushName = null) => {
    try {
        let profilePicUrl = null;
        try {
            profilePicUrl = await sock.profilePictureUrl(jid, 'image');
        } catch (e) { /* Sem foto */ }

        const contactData = {
            jid: jid,
            profile_pic_url: profilePicUrl,
            updated_at: new Date()
        };
        
        if (pushName) contactData.push_name = pushName;
        if (pushName) contactData.name = pushName;

        await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
    } catch (err) {
        console.error("Erro ao salvar contato:", jid);
    }
};

export const startSession = async (sessionId, companyId) => {
  // Limpeza prévia se existir
  if (sessions.has(sessionId)) {
      const oldSock = sessions.get(sessionId);
      if (oldSock) { oldSock.shouldReconnect = false; oldSock.end(undefined); }
      sessions.delete(sessionId);
      companyIndex.delete(companyId); // Limpa index antigo
  }

  const { state, saveCreds } = await useSupabaseAuthState(sessionId);
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "error" }),
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true, 
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 5000,
  });

  sock.shouldReconnect = true; 
  
  // --- AQUI ESTÁ A CORREÇÃO DE MAPEAMENTO ---
  sessions.set(sessionId, sock); 
  if (companyId) {
      companyIndex.set(companyId, sessionId);
      console.log(`[MAP] Empresa ${companyId} vinculada à sessão ${sessionId}`);
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (sock.shouldReconnect === false) return;

    if (connection === 'connecting') await supabase.from("instances").update({ status: "connecting" }).eq("session_id", sessionId);
    
    if (qr) await supabase.from("instances").upsert({ session_id: sessionId, qrcode_url: qr, status: "qrcode", company_id: companyId, name: "WhatsApp Principal" }, { onConflict: 'session_id' });

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
          // Mantém o mapa, pois vai reconectar
          sessions.delete(sessionId);
          await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
          setTimeout(() => { if (sock.shouldReconnect) startSession(sessionId, companyId); }, 3000);
      } else {
          sock.shouldReconnect = false; 
          await deleteSession(sessionId, companyId);
      }
    }

    if (connection === "open") await supabase.from("instances").update({ status: "connected", qrcode_url: null }).eq("session_id", sessionId);
  });

  sock.ev.on("messaging-history.set", async ({ messages, contacts }) => {
      console.log(`[HISTORY] Processando ${messages.length} mensagens e ${contacts?.length || 0} contatos...`);
      const formattedMessages = messages.map(msg => extractMessageData(msg, sessionId)).filter(Boolean);
      await saveMessagesBatch(formattedMessages);

      if (contacts) {
         const contactBatch = contacts.map(c => ({
             jid: c.id,
             name: c.name || c.notify || c.verifiedName,
             push_name: c.notify
         }));
         const BATCH = 50;
         for (let i = 0; i < contactBatch.length; i += BATCH) {
            await supabase.from('contacts').upsert(contactBatch.slice(i, i + BATCH), { onConflict: 'jid' });
         }
      }
  });

  sock.ev.on("contacts.upsert", async (contacts) => {
      for (const c of contacts) {
          await upsertContact(c.id, sock, c.name || c.notify);
      }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (sock.shouldReconnect === false) return;
    const formattedMessages = messages.map(msg => extractMessageData(msg, sessionId)).filter(Boolean);

    if (formattedMessages.length > 0) {
        console.log(`[MSG] Recebida: ${formattedMessages[0].content.substring(0, 20)}...`);
        await supabase.from('messages').insert(formattedMessages);
        for (const msg of formattedMessages) {
            if (!msg.from_me) {
                await upsertContact(msg.remote_jid, sock);
            }
        }
    }
  });

  return sock;
};

export const deleteSession = async (sessionId, companyId) => {
    console.log(`[RESET] Deletando sessão ${sessionId}...`);
    const sock = sessions.get(sessionId);
    
    if (sock) { 
        sock.shouldReconnect = false; 
        try { sock.end(undefined); } catch (e) {} 
    }
    
    sessions.delete(sessionId);
    
    // Limpeza do Indexador
    if (companyId) {
        companyIndex.delete(companyId);
    }

    await supabase.from("instances").delete().eq("session_id", sessionId);
    await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);
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

// 2. Função para o CONTROLLER/INTERNO (Retorna o Socket/Conexão Real)
// Agora acessamos o indexador local 'companyIndex' e depois o mapa 'sessions'
export const getSession = (companyId) => {
    const sessionId = companyIndex.get(companyId);
    
    if (!sessionId) {
        // Fallback: Se não achar no index
        console.warn(`[WARN] Sessão não encontrada via index para empresa ${companyId}.`);
        return null;
    }
    
    return sessions.get(sessionId);
};
