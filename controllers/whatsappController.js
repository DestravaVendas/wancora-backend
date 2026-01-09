import makeWASocket, { DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Mapa de sessões ativas
const sessions = new Map();

export const startSession = async (sessionId, companyId) => {
  // 1. Limpeza Prévia: Se já existe sessão, marca para não reconectar e mata
  if (sessions.has(sessionId)) {
      console.log(`[START] Sessão ${sessionId} já existe. Substituindo...`);
      const oldSock = sessions.get(sessionId);
      if (oldSock) {
          oldSock.shouldReconnect = false; // 🔥 PROIBIDO RECONECTAR
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
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 5000,
  });

  // 🔥 A BANDEIRA DE VIDA: Por padrão, permitimos reconectar
  sock.shouldReconnect = true; 

  // Adiciona na memória
  sessions.set(sessionId, sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Se essa sessão foi marcada para morrer, IGNORA tudo e retorna.
    if (sock.shouldReconnect === false) {
        console.log(`[ZOMBIE KILLER] Sessão ${sessionId} tentou reviver mas foi bloqueada.`);
        return;
    }

    if (connection === 'connecting') {
        console.log("[STATUS] Iniciando conexão/sincronização...");
        await supabase.from("instances").update({ status: "connecting" }).eq("session_id", sessionId);
    }
    
    if (qr) {
      console.log(`[QR GENERATED] Nova tentativa de login para ${sessionId}`);
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
      
      console.log(`[CLOSE] Conexão caiu. Reconectar? ${shouldReconnect}`);

      if (shouldReconnect) {
          // Remove da memória para garantir limpeza
          sessions.delete(sessionId);
          await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
          
          console.log("[AUTO-RECONNECT] Tentando reconectar em 3s...");
          setTimeout(() => {
              // Verifica se não foi cancelado nesse meio tempo
              if (sock.shouldReconnect) {
                startSession(sessionId, companyId);
              }
          }, 3000);
      } else {
          console.log("[LOGOUT] Desconectado definitivamente.");
          // Se foi logout real pelo celular, marcamos para não voltar
          sock.shouldReconnect = false; 
          await deleteSession(sessionId, companyId);
      }
    }

    if (connection === "open") {
      console.log("[SUCCESS] Conectado e pronto!");
      await supabase.from("instances").update({ 
        status: "connected", 
        qrcode_url: null 
      }).eq("session_id", sessionId);
    }
  });

// Listener de mensagens
  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (sock.shouldReconnect === false) return;

    for (const msg of messages) {
        if (!msg.message) continue;

        const remoteJid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        // Pega texto de diferentes tipos de msg (texto simples ou extended)
        const content = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";

        if (content) {
            console.log(`[MSG] ${fromMe ? 'Eu' : 'Cliente'}: ${content}`);
            
            // 🔥 SALVA NO SUPABASE
            await supabase.from('messages').insert({
                session_id: sessionId,
                remote_jid: remoteJid,
                from_me: fromMe,
                content: content,
                message_type: 'text',
                status: 'received'
            });
        }
    }
  });

// 🔥 FUNÇÃO DE RESET (KILL SWITCH)
export const deleteSession = async (sessionId, companyId) => {
    console.log(`[RESET] Deletando sessão ${sessionId}...`);
    
    const sock = sessions.get(sessionId);

    // 1. MARCA A BANDEIRA: "VOCÊ VAI MORRER E NÃO VAI VOLTAR"
    if (sock) {
        sock.shouldReconnect = false; 
        try {
            sock.end(undefined); // Isso vai disparar 'close', mas o IF lá em cima vai bloquear o reconnect
        } catch (e) {
            console.log("Erro ao fechar socket:", e.message);
        }
    }

    // 2. Remove do mapa
    sessions.delete(sessionId);

    // 3. Limpa o banco
    await supabase.from("instances").delete().eq("session_id", sessionId);
    await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);
    
    console.log(`[RESET] Sessão limpa com sucesso.`);
    return true;
};

export const sendMessage = async (sessionId, to, text) => {
  const sock = sessions.get(sessionId);
  if (!sock) throw new Error("Sessão não ativa");
  const jid = `${to}@s.whatsapp.net`;
  return await sock.sendMessage(jid, { text });
};
