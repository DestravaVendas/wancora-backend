import makeWASocket, { DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Mapa de sessões ativas
const sessions = new Map();

// --- FUNÇÃO AUXILIAR: Extrai dados úteis da mensagem ---
const extractMessageData = (msg, sessionId) => {
    if (!msg.message) return null;

    // Ignora mensagens de protocolo/status (aquelas "azulzinhas" de segurança)
    if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return null;

    const remoteJid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;
    
    // Tenta pegar o texto de várias formas (simples, estendido, legenda de imagem, etc)
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

    // Converte timestamp do WhatsApp (segundos) para ISO String (Date)
    // Se não tiver timestamp (msg antiga), usa o momento atual
    const messageTimestamp = msg.messageTimestamp 
        ? new Date(msg.messageTimestamp * 1000).toISOString() 
        : new Date().toISOString();

    return {
        session_id: sessionId,
        remote_jid: remoteJid,
        from_me: fromMe,
        content: content,
        message_type: 'text', // Simplificado para MVP
        status: 'received',
        created_at: messageTimestamp
    };
};

// --- FUNÇÃO AUXILIAR: Salva mensagens em lote no Supabase ---
const saveMessagesBatch = async (messages) => {
    if (!messages || messages.length === 0) return;
    
    // Salva em lotes de 50 para não estourar o limite do Supabase
    const BATCH_SIZE = 50;
    
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        try {
            // Usamos upsert para evitar erros se duplicar, mas idealmente precisariamos de um ID único do whats
            // Como nosso banco gera ID UUID automático, cuidado com duplicações se escanear muitas vezes.
            // Para MVP, insert simples funciona bem.
            const { error } = await supabase.from('messages').insert(batch);
            if (error) console.error("Erro ao salvar lote:", error.message);
        } catch (err) {
            console.error("Erro crítico no batch:", err.message);
        }
    }
    console.log(`[DB] ${messages.length} mensagens salvas no histórico.`);
};


export const startSession = async (sessionId, companyId) => {
  // 1. Limpeza Prévia
  if (sessions.has(sessionId)) {
      console.log(`[START] Sessão ${sessionId} já existe. Substituindo...`);
      const oldSock = sessions.get(sessionId);
      if (oldSock) {
          oldSock.shouldReconnect = false;
          oldSock.end(undefined);
      }
      sessions.delete(sessionId);
  }

  const { state, saveCreds } = await useSupabaseAuthState(sessionId);
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "error" }),
    browser: Browsers.macOS('Desktop'),
    
    // 🔥 AQUI ESTÁ A MÁGICA: Ativamos o histórico completo
    syncFullHistory: true, 
    
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 5000,
  });

  sock.shouldReconnect = true; 
  sessions.set(sessionId, sock);

  sock.ev.on("creds.update", saveCreds);

  // --- EVENTO: CONEXÃO ---
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (sock.shouldReconnect === false) return;

    if (connection === 'connecting') {
        console.log("[STATUS] Iniciando conexão...");
        await supabase.from("instances").update({ status: "connecting" }).eq("session_id", sessionId);
    }
    
    if (qr) {
      console.log(`[QR] Novo QR Code gerado.`);
      await supabase.from("instances").upsert({ 
        session_id: sessionId, 
        qrcode_url: qr, 
        status: "qrcode",
        company_id: companyId,
        name: "WhatsApp Principal"
      }, { onConflict: 'session_id' });
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[CLOSE] Desconectado. Reconectar? ${shouldReconnect}`);

      if (shouldReconnect) {
          sessions.delete(sessionId);
          await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
          setTimeout(() => {
              if (sock.shouldReconnect) startSession(sessionId, companyId);
          }, 3000);
      } else {
          console.log("[LOGOUT] Logout definitivo.");
          sock.shouldReconnect = false; 
          await deleteSession(sessionId, companyId);
      }
    }

    if (connection === "open") {
      console.log("[SUCCESS] Conectado! Aguardando mensagens...");
      await supabase.from("instances").update({ status: "connected", qrcode_url: null }).eq("session_id", sessionId);
    }
  });

  // --- EVENTO: HISTÓRICO ANTIGO (Carrega ao conectar) ---
  sock.ev.on("messaging-history.set", async ({ messages }) => {
      console.log(`[HISTORY] Recebendo histórico com ${messages.length} mensagens...`);
      
      // Filtra e formata
      const formattedMessages = messages
          .map(msg => extractMessageData(msg, sessionId))
          .filter(Boolean); // Remove nulos
      
      if (formattedMessages.length > 0) {
          console.log(`[HISTORY] Salvando ${formattedMessages.length} mensagens válidas no banco...`);
          await saveMessagesBatch(formattedMessages);
      }
  });

  // --- EVENTO: MENSAGENS NOVAS (Tempo real) ---
  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (sock.shouldReconnect === false) return;

    const formattedMessages = messages
        .map(msg => extractMessageData(msg, sessionId))
        .filter(Boolean);

    if (formattedMessages.length > 0) {
        console.log(`[NEW MSG] ${formattedMessages.length} novas mensagens recebidas.`);
        // Para mensagens novas (poucas), insert direto é tranquilo
        await supabase.from('messages').insert(formattedMessages);
    }
  });

  return sock;
};

// --- FUNÇÃO: RESET ---
export const deleteSession = async (sessionId, companyId) => {
    console.log(`[RESET] Deletando sessão ${sessionId}...`);
    const sock = sessions.get(sessionId);

    if (sock) {
        sock.shouldReconnect = false; 
        try { sock.end(undefined); } catch (e) {}
    }

    sessions.delete(sessionId);
    await supabase.from("instances").delete().eq("session_id", sessionId);
    await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);
    
    // Opcional: Se quiser limpar o histórico de mensagens ao desconectar, descomente abaixo.
    // Mas geralmente num CRM queremos manter o histórico.
    // await supabase.from("messages").delete().eq("session_id", sessionId);

    console.log(`[RESET] Sessão limpa.`);
    return true;
};

// --- FUNÇÃO: ENVIAR ---
export const sendMessage = async (sessionId, to, text) => {
  const sock = sessions.get(sessionId);
  if (!sock) throw new Error("Sessão não ativa");
  const jid = `${to}@s.whatsapp.net`;
  return await sock.sendMessage(jid, { text });
};
