import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const sessions = new Map();

export const startSession = async (sessionId, companyId) => {
  console.log(`[CONTROLLER] Iniciando sessão para ${sessionId} (Empresa: ${companyId})`);

  if (sessions.has(sessionId)) {
      console.log("[CONTROLLER] Sessão já existe em memória.");
      return sessions.get(sessionId);
  }

  // Carrega o Auth
  console.log("[CONTROLLER] Carregando estado de autenticação...");
  const { state, saveCreds } = await useSupabaseAuthState(sessionId);
  
  console.log("[CONTROLLER] Criando Socket do Baileys...");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // Útil para ver no log do Render também
    logger: pino({ level: "info" }), // ATENÇÃO: Mudado de silent para info para DEBUG
    browser: ["Wancora CRM", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000, // Aumentando timeout
  });

  sessions.set(sessionId, sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    console.log(`[CONNECTION UPDATE] Status: ${connection || 'mudando'} | QR: ${!!qr}`);

   if (qr) {
      console.log("[DB] Salvando QR Code no Supabase...");
      const { error } = await supabase.from("instances").upsert({ 
        session_id: sessionId, 
        qrcode_url: qr, 
        status: "qrcode",
        company_id: companyId,
        name: "WhatsApp Principal"
      }, { onConflict: 'session_id' }); // 🔥 AQUI ESTÁ A CORREÇÃO MÁGICA

      if (error) console.error("[DB ERROR] Erro ao salvar QR:", error.message);
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[CONNECTION CLOSE] Desconectado. Reconectar? ${shouldReconnect}`);
      
      await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
      
      if (shouldReconnect) {
          startSession(sessionId, companyId);
      } else {
          sessions.delete(sessionId);
      }
    }

    if (connection === "open") {
      console.log("[CONNECTION OPEN] Conectado com sucesso!");
      await supabase.from("instances").update({ 
        status: "connected", 
        qrcode_url: null 
      }).eq("session_id", sessionId);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    // Mantive a lógica de mensagens igual, pois ela não impede a conexão
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    const phone = remoteJid.replace("@s.whatsapp.net", "");
    const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text;

    if (!messageContent) return; 

    // Lead Capture Logic
    let { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("phone", phone)
      .eq("company_id", companyId)
      .single();

    if (!lead) {
      const { data: newLead } = await supabase.from("leads").insert({
        phone,
        name: msg.pushName || "Novo Contato",
        company_id: companyId,
        lead_score: 0,
        tags: ["novo"]
      }).select("id").single();
      if (newLead) lead = newLead;
    }

    if (lead) {
        await supabase.from("messages").insert({
        company_id: companyId,
        lead_id: lead.id, 
        direction: "inbound",
        type: "text",
        content: messageContent,
        status: "received"
        });
    }
  });

  return sock;
};

export const sendMessage = async (sessionId, to, text) => {
  const sock = sessions.get(sessionId);
  if (!sock) throw new Error("Sessão não ativa");
  const jid = `${to}@s.whatsapp.net`;
  return await sock.sendMessage(jid, { text });
};
