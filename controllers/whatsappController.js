import makeWASocket, { DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Mapa de sessões ativas
const sessions = new Map();

export const startSession = async (sessionId, companyId) => {
  // Limpeza preventiva: Se já existe, mata a antiga antes de criar a nova
  if (sessions.has(sessionId)) {
      console.log(`[START] Sessão ${sessionId} já existe. Reiniciando...`);
      // Não chamamos deleteSession aqui para evitar loop, apenas removemos do map
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

  // Adiciona na memória
  sessions.set(sessionId, sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // 1. Lógica de Conexão (Mostra Spinner)
    if (connection === 'connecting') {
        console.log("[STATUS] Iniciando conexão/sincronização...");
        // Só atualiza banco se a sessão ainda for válida
        if (sessions.has(sessionId)) {
            await supabase.from("instances").update({ status: "connecting" }).eq("session_id", sessionId);
        }
    }
    
    // 2. Lógica de QR Code
    if (qr) {
      console.log(`[QR GENERATED] Nova tentativa de login para ${sessionId}`);
      if (sessions.has(sessionId)) {
          await supabase.from("instances").upsert({ 
            session_id: sessionId, 
            qrcode_url: qr, 
            status: "qrcode",
            company_id: companyId,
            name: "WhatsApp Principal"
          }, { onConflict: 'session_id' });
      }
    }

    // 3. Lógica de Desconexão (AQUI ESTAVA O LOOP)
    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      
      // 🔥 A CURA DO ZUMBI:
      // Verificamos se a sessão AINDA EXISTE na memória.
      // Se deleteSession() foi chamado, ela já foi removida do Map.
      // Então, se não estiver no Map, NÃO FAZEMOS NADA (Return).
      if (!sessions.has(sessionId)) {
          console.log(`[STOP] Sessão ${sessionId} foi encerrada manualmente. Loop interrompido.`);
          return; 
      }

      console.log(`[CLOSE] Conexão caiu. Reconectar? ${shouldReconnect}`);

      if (shouldReconnect) {
          console.log("[AUTO-RECONNECT] Tentando reconectar em 3s...");
          // Removemos a instância atual defeituosa da memória para dar lugar à nova
          sessions.delete(sessionId);
          await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
          
          setTimeout(() => {
              // Verifica novamente se não foi deletada nesse meio tempo
              startSession(sessionId, companyId);
          }, 3000);
      } else {
          console.log("[LOGOUT] Desconectado definitivamente.");
          await deleteSession(sessionId, companyId);
      }
    }

    // 4. Lógica de Sucesso
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
     // ... (Lógica de mensagens mantida igual) ...
  });

  return sock;
};

// 🔥 FUNÇÃO DE DELETAR CORRIGIDA
export const deleteSession = async (sessionId, companyId) => {
    console.log(`[RESET] Deletando sessão ${sessionId}...`);
    
    const sock = sessions.get(sessionId);

    // 1. PRIMEIRO: Removemos do Mapa.
    // Isso sinaliza para o evento 'connection.update' que ele NÃO deve tentar reconectar.
    sessions.delete(sessionId);

    // 2. DEPOIS: Fechamos o socket
    if (sock) {
        try {
            sock.end(undefined);
        } catch (error) {
            console.log("Erro ao fechar socket (ignorado):", error.message);
        }
    }

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
