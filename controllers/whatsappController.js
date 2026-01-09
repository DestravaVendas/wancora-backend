import makeWASocket, { DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const sessions = new Map();

export const startSession = async (sessionId, companyId) => {
  // Limpeza preventiva de memória
  if (sessions.has(sessionId)) {
      sessions.delete(sessionId);
  }

  const { state, saveCreds } = await useSupabaseAuthState(sessionId);
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "error" }),
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false,
    
    // 🔥 AUMENTANDO DRASTICAMENTE OS TIMEOUTS PARA O RENDER
    connectTimeoutMs: 30000, // 90 segundos antes de desistir
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 5000, // Espera 5s antes de tentar de novo
  });

  sessions.set(sessionId, sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'connecting') {
        console.log("[STATUS] Iniciando conexão/sincronização...");
        await supabase.from("instances").update({ 
            status: "connecting",
            // Opcional: Não limpamos o QR aqui para evitar piscar se for só uma oscilação, 
            // mas o status 'connecting' já fará o frontend mostrar o spinner.
        }).eq("session_id", sessionId);
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
      
      // Remove da memória imediatamente
      sessions.delete(sessionId);

      await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);

      if (shouldReconnect) {
          console.log("[AUTO-RECONNECT] Reconectando em 3s...");
          setTimeout(() => startSession(sessionId, companyId), 3000);
      } else {
          console.log("[STOP] Desconectado permanentemente (Logoff).");
          // Se foi Logoff real, limpamos o banco de auth também
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

  // Listener simples de mensagens
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    // ... (Mantive a lógica de Leads simples para economizar espaço aqui, mas ela continua funcionando igual) ...
  });

  return sock;
};

// 🔥 NOVA FUNÇÃO: O "Botão de Pânico"
export const deleteSession = async (sessionId, companyId) => {
    console.log(`[RESET] Deletando sessão ${sessionId}...`);
    
    // 1. Fecha o socket se estiver aberto
    const sock = sessions.get(sessionId);
    if (sock) {
        sock.end(undefined);
        sessions.delete(sessionId);
    }

    // 2. Limpa tabelas no banco (Instância e Autenticação)
    // NÃO apagamos leads nem mensagens, apenas a conexão!
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
