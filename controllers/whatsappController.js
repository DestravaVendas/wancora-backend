import makeWASocket, { DisconnectReason } from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const sessions = new Map();

export const startSession = async (sessionId, companyId) => {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const { state, saveCreds } = await useSupabaseAuthState(sessionId);
  
  const sock = makeWASocket.default({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Wancora CRM", "Chrome", "1.0.0"],
  });

  sessions.set(sessionId, sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      await supabase.from("instances").upsert({ 
        session_id: sessionId, 
        qrcode_url: qr, 
        status: "qrcode",
        company_id: companyId 
      });
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
      if (shouldReconnect) startSession(sessionId, companyId);
    }

    if (connection === "open") {
      await supabase.from("instances").update({ 
        status: "connected", 
        qrcode_url: null 
      }).eq("session_id", sessionId);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    const phone = remoteJid.replace("@s.whatsapp.net", "");
    const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text;

    if (!messageContent) return; // Ignora status/presença

    // 1. Lead Capture Logic (Tenta achar o Lead)
    let { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("phone", phone)
      .eq("company_id", companyId)
      .single();

    // 2. Se não existir, Cria e Recupera o ID
    if (!lead) {
      const { data: newLead, error } = await supabase.from("leads").insert({
        phone,
        name: msg.pushName || "Novo Contato",
        company_id: companyId,
        lead_score: 0,
        tags: ["novo"]
      }).select("id").single();
      
      if (newLead) lead = newLead;
    }

    // 3. Save Message (Usando o UUID correto)
    if (lead) {
        await supabase.from("messages").insert({
        company_id: companyId,
        lead_id: lead.id, // <--- CORREÇÃO AQUI (Era lead_phone)
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