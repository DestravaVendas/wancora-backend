import makeWASocket, { DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Mapa de sessões ativas
const sessions = new Map();

// --- FUNÇÃO AUXILIAR 1: Extrai dados úteis da mensagem ---
const extractMessageData = (msg, sessionId) => {
    if (!msg.message) return null;
    if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return null;

    const remoteJid = msg.key.remoteJid;
    // Filtro de segurança: Ignora grupos e broadcast para focar no atendimento
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
            // Tenta buscar a foto (pode falhar se for privado)
            profilePicUrl = await sock.profilePictureUrl(jid, 'image');
        } catch (e) { /* Sem foto */ }

        const contactData = {
            jid: jid,
            profile_pic_url: profilePicUrl,
            updated_at: new Date()
        };
        
        // Só atualiza o nome se tivermos um novo (para não sobrescrever com null)
        if (pushName) contactData.push_name = pushName;
        if (pushName) contactData.name = pushName;

        await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
    } catch (err) {
        console.error("Erro ao salvar contato:", jid);
    }
};

export const startSession = async (sessionId, companyId) => {
  if (sessions.has(sessionId)) {
      const oldSock = sessions.get(sessionId);
      if (oldSock) { oldSock.shouldReconnect = false; oldSock.end(undefined); }
      sessions.delete(sessionId);
  }

  const { state, saveCreds } = await useSupabaseAuthState(sessionId);
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "error" }),
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true, // Histórico ATIVADO
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 5000,
  });

  sock.shouldReconnect = true; 
  sessions.set(sessionId, sock);

  sock.ev.on("creds.update", saveCreds);

  // --- CONEXÃO ---
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (sock.shouldReconnect === false) return;

    if (connection === 'connecting') await supabase.from("instances").update({ status: "connecting" }).eq("session_id", sessionId);
    
    if (qr) await supabase.from("instances").upsert({ session_id: sessionId, qrcode_url: qr, status: "qrcode", company_id: companyId, name: "WhatsApp Principal" }, { onConflict: 'session_id' });

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
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

  // --- EVENTO 1: CARGA INICIAL DE HISTÓRICO + CONTATOS ---
  sock.ev.on("messaging-history.set", async ({ messages, contacts }) => {
      console.log(`[HISTORY] Processando ${messages.length} mensagens e ${contacts?.length || 0} contatos...`);
      
      // 1. Salva Mensagens
      const formattedMessages = messages.map(msg => extractMessageData(msg, sessionId)).filter(Boolean);
      await saveMessagesBatch(formattedMessages);

      // 2. Salva Contatos (Nomes iniciais)
      if (contacts) {
         const contactBatch = contacts.map(c => ({
             jid: c.id,
             name: c.name || c.notify || c.verifiedName,
             push_name: c.notify
         }));
         // Batch insert de contatos
         const BATCH = 50;
         for (let i = 0; i < contactBatch.length; i += BATCH) {
            await supabase.from('contacts').upsert(contactBatch.slice(i, i + BATCH), { onConflict: 'jid' });
         }
      }
  });

  // --- EVENTO 2: ATUALIZAÇÃO DE CONTATOS (Chegou nome novo) ---
  sock.ev.on("contacts.upsert", async (contacts) => {
      for (const c of contacts) {
          // Salva nome e tenta buscar foto
          await upsertContact(c.id, sock, c.name || c.notify);
      }
  });

  // --- EVENTO 3: MENSAGENS NOVAS ---
  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (sock.shouldReconnect === false) return;

    const formattedMessages = messages.map(msg => extractMessageData(msg, sessionId)).filter(Boolean);

    if (formattedMessages.length > 0) {
        console.log(`[MSG] Recebida: ${formattedMessages[0].content.substring(0, 20)}...`);
        await supabase.from('messages').insert(formattedMessages);
        
        // Se chegou mensagem, garante que temos a foto/nome desse contato atualizados
        for (const msg of formattedMessages) {
            if (!msg.from_me) {
                await upsertContact(msg.remote_jid, sock);
            }
        }
    }
  });

  return sock;
};

// --- FUNÇÃO: RESET ---
export const deleteSession = async (sessionId, companyId) => {
    console.log(`[RESET] Deletando...`);
    const sock = sessions.get(sessionId);
    if (sock) { sock.shouldReconnect = false; try { sock.end(undefined); } catch (e) {} }
    sessions.delete(sessionId);
    await supabase.from("instances").delete().eq("session_id", sessionId);
    await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);
    return true;
};

// --- FUNÇÃO: ENVIAR ---
export const sendMessage = async (sessionId, to, text) => {
  const sock = sessions.get(sessionId);
  if (!sock) throw new Error("Sessão não ativa");
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  return await sock.sendMessage(jid, { text });
};

// --- Adição para o Motor de Campanhas ---

/**
 * Retorna a instância do socket do WhatsApp ativa para uma empresa.
 * Usado pelos Workers de fila.
 * @param {string} companyId - ID da empresa (ou sessionId dependendo da sua lógica atual)
 */
export const getSession = (companyId) => {
    // SE O SEU CÓDIGO USA UM MAPA CHAMADO 'sessions':
    if (global.sessions) {
        return global.sessions.get(companyId);
    }
    
    // SE O SEU CÓDIGO USA UMA VARIÁVEL LOCAL (NÃO RECOMENDADO PARA PROD, MAS COMUM EM MVP):
    // Você precisará refatorar para usar 'global.sessions = new Map()' no topo do arquivo.
    return null;
};
