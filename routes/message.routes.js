import express from "express";
import { createClient } from "@supabase/supabase-js";
import { sendMessage, sendPollVote, sendReaction, deleteMessage } from "../controllers/whatsappController.js"; 
import { requireAuth } from "../middleware/auth.js";
import { apiLimiter } from "../middleware/limiter.js";
import { normalizeJid } from "../utils/wppParsers.js"; // Importando normalizador

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Middleware Global para este router
router.use(requireAuth);
router.use(apiLimiter);

// Enviar Mensagem
router.post("/send", async (req, res) => {
  const { 
      sessionId, to, text, type, url, caption, 
      poll, location, contact, ptt, mimetype, fileName, companyId 
  } = req.body;
  
  if (!sessionId || !to) {
      return res.status(400).json({ error: "SessionId e Destinatário são obrigatórios" });
  }

  try {
    // Normalização Segura do Destinatário
    const cleanTo = normalizeJid(to);
    
    const payload = {
        sessionId,
        to: cleanTo,
        type: type || 'text',
        content: text,
        url, caption, poll, location, contact, ptt, mimetype, fileName
    };

    // 1. Envio via Baileys
    const sentMsg = await sendMessage(payload);
    
    // 2. Salvamento Otimista
    // Isso garante que a mensagem apareça no chat instantaneamente para quem enviou
    if (companyId && sentMsg?.key) {
        
        // Tenta vincular ao Lead existente
        let leadId = null;
        const phoneClean = cleanTo.split('@')[0].replace(/\D/g, '');
        const { data: lead } = await supabase.from("leads").select("id").eq("phone", phoneClean).eq("company_id", companyId).maybeSingle();
        if (lead) leadId = lead.id;

        // Prepara conteúdo para exibição no banco
        let displayContent = text || caption || `[${payload.type}]`;
        if (payload.type === 'poll' && poll) displayContent = JSON.stringify(poll);
        else if (payload.type === 'location' && location) displayContent = JSON.stringify(location);
        else if (payload.type === 'contact' && contact) displayContent = JSON.stringify(contact);
        else if (payload.type === 'pix') displayContent = text;

        await supabase.from("messages").upsert({
            company_id: companyId,
            lead_id: leadId,
            session_id: sessionId,
            remote_jid: cleanTo,
            whatsapp_id: sentMsg.key.id,
            from_me: true,
            message_type: payload.type,
            content: displayContent,
            media_url: url,
            status: "sent",
            created_at: new Date()
        }, { onConflict: 'remote_jid, whatsapp_id' });
    }

    res.json({ success: true, id: sentMsg?.key?.id });

  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error);
    res.status(500).json({ error: "Falha no envio: " + (error.message || error) });
  }
});

// Votar em Enquete
router.post("/vote", async (req, res) => {
    const { companyId, sessionId, remoteJid, pollId, optionId } = req.body;
    
    // Validação estrita
    if(!pollId || optionId === undefined) {
        return res.status(400).json({ error: "PollId e OptionId obrigatórios" });
    }

    try {
        await sendPollVote(sessionId, companyId, remoteJid, pollId, optionId);
        res.json({ success: true });
    } catch (error) {
        console.error("Erro ao votar:", error);
        res.status(500).json({ error: error.message });
    }
});

// Reagir
router.post("/react", async (req, res) => {
    const { sessionId, companyId, remoteJid, msgId, reaction } = req.body;
    try {
        await sendReaction(sessionId, companyId, remoteJid, msgId, reaction);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Deletar
router.post("/delete", async (req, res) => {
    const { sessionId, companyId, remoteJid, msgId, everyone } = req.body;
    try {
        await deleteMessage(sessionId, companyId, remoteJid, msgId, everyone);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
