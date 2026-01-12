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

  // Inicia sem travar a resposta
  whatsappController.startSession(sessionId, companyId).catch(err => console.error(err));
  res.status(200).json({ message: "Iniciando..." });
});

router.post("/session/logout", async (req, res) => {
  const { sessionId, companyId } = req.body;
  await whatsappController.deleteSession(sessionId, companyId);
  res.json({ message: "Desconectado." });
});

// ⚠️ ROTA VITAL QUE A OUTRA IA TINHA REMOVIDO ⚠️
router.get("/session/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { data, error } = await supabase.from("instances").select("*").eq("session_id", sessionId).single();
  if (error) return res.status(404).json({ error: "Sessão não encontrada" });
  res.json(data);
});

// --- ENVIO DE MENSAGENS (UPGRADED) ---
router.post("/message/send", async (req, res) => {
  const { sessionId, to, text, type, url, caption, options, companyId } = req.body;
  
  try {
    const payload = {
        type: type || 'text',
        content: text,
        url: url,
        caption: caption,
        values: options,
        ptt: true
    };

    const sentMsg = await whatsappController.sendMessage(sessionId, to, payload);
    
    // Salva no banco (Optimistic UI)
    if (companyId && to) {
        const remoteJid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        const phone = to.split('@')[0];
        
        // Garante que o lead existe antes de salvar msg de saída (Anti-Erro)
        let leadId = null;
        const { data: lead } = await supabase.from("leads").select("id").eq("phone", phone).eq("company_id", companyId).maybeSingle();
        if (lead) leadId = lead.id;

        await supabase.from("messages").insert({
            company_id: companyId,
            lead_id: leadId,
            session_id: sessionId,
            remote_jid: remoteJid,
            direction: "outbound",
            from_me: true,
            type: payload.type,
            content: text || caption || (payload.type === 'poll' ? 'Enquete' : `[${payload.type}]`),
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

// Rota de Campanhas (Mantida)
router.post("/campaigns/send", createCampaign);

export default router;
