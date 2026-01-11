import express from "express";
import * as whatsappController from "./controllers/whatsappController.js";
import { createCampaign } from "./controllers/campaignController.js";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- SESSÃO ---
router.post("/session/start", async (req, res) => {
  const { sessionId, companyId } = req.body;
  if (!sessionId || !companyId) return res.status(400).json({ error: "Dados incompletos" });

  whatsappController.startSession(sessionId, companyId).catch(err => console.error(err));
  res.status(200).json({ message: "Iniciando..." });
});

router.post("/session/logout", async (req, res) => {
  const { sessionId, companyId } = req.body;
  await whatsappController.deleteSession(sessionId, companyId);
  res.json({ message: "Desconectado." });
});

router.get("/session/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { data, error } = await supabase.from("instances").select("*").eq("session_id", sessionId).single();
  if (error) return res.status(404).json({ error: "Sessão não encontrada" });
  res.json(data);
});

// --- ENVIO DE MENSAGENS (UPGRADED 🚀) ---
router.post("/message/send", async (req, res) => {
  // Agora aceitamos 'type' e 'url'/'caption'/'options' além de 'text'
  const { sessionId, to, text, type, url, caption, options, companyId } = req.body;
  
  try {
    // Monta o payload baseado no que o Frontend mandou
    const payload = {
        type: type || 'text', // Se não mandar tipo, assume texto
        content: text,        // Para texto simples
        url: url,             // Para mídia
        caption: caption,     // Para legenda de mídia
        values: options,      // Para enquete
        ptt: true             // Para áudio (default voice note)
    };

    const sentMsg = await whatsappController.sendMessage(sessionId, to, payload);
    
    // Salva no banco manualmente para garantir feedback instantâneo no chat (optimistic)
    if (companyId && to) {
        const remoteJid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        // Busca Lead ID se existir
        const { data: lead } = await supabase.from("leads").select("id").eq("phone", to.split('@')[0]).eq("company_id", companyId).single();

        await supabase.from("messages").insert({
            company_id: companyId,
            lead_id: lead?.id || null,
            session_id: sessionId,
            remote_jid: remoteJid,
            direction: "outbound",
            from_me: true,
            type: payload.type,
            content: text || caption || (payload.type === 'poll' ? JSON.stringify({name: 'Enquete', options}) : `[${payload.type}]`),
            status: "sent",
            created_at: new Date()
        });
    }

    res.json({ success: true, id: sentMsg?.key?.id });
  } catch (error) {
    console.error("Erro envio:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/campaigns/send", createCampaign);

export default router;
