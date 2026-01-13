// routes.js
import express from "express";
import * as whatsappController from "./controllers/whatsappController.js";
import { createCampaign } from "./controllers/campaignController.js";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==============================================================================
// 1. ROTAS DE SESSÃO
// ==============================================================================

router.post("/session/start", async (req, res) => {
  const { sessionId, companyId } = req.body;
  
  if (!sessionId || !companyId) {
    return res.status(400).json({ error: "Dados incompletos (sessionId/companyId faltando)" });
  }

  whatsappController.startSession(sessionId, companyId).catch(err => {
    console.error(`❌ Erro fatal ao iniciar sessão ${sessionId}:`, err);
  });
  
  res.status(200).json({ message: "Iniciando processo de conexão..." });
});

router.post("/session/logout", async (req, res) => {
  const { sessionId, companyId } = req.body;
  try {
    await whatsappController.deleteSession(sessionId, companyId);
    res.json({ message: "Sessão desconectada com sucesso." });
  } catch (error) {
    console.error("Erro no logout:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/session/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { data, error } = await supabase.from("instances").select("*").eq("session_id", sessionId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ status: "not_found" });
  res.json(data);
});

// ==============================================================================
// 2. ROTAS DE MENSAGEM (CORRIGIDA E EXPANDIDA)
// ==============================================================================

router.post("/message/send", async (req, res) => {
  // Desestrutura TODOS os campos possíveis vindos do Frontend moderno
  const { 
      sessionId, 
      to, 
      text, 
      type, 
      url, 
      caption, 
      poll,      // Objeto JSON: { name, options, selectableOptionsCount }
      location,  // Objeto JSON: { latitude, longitude }
      contact,   // Objeto JSON: { displayName, vcard }
      ptt,       // Boolean (para áudio)
      mimetype,  // String (para doc/audio)
      fileName,  // String (para doc)
      companyId 
  } = req.body;
  
  // Validação básica
  if (!sessionId || !to) {
      return res.status(400).json({ error: "SessionId e Destinatário (to) são obrigatórios" });
  }

  try {
    // 1. Monta o Payload Unificado para o Controller
    const payload = {
        type: type || 'text',
        content: text,
        text: text, // Fallback
        url: url,
        caption: caption,
        poll: poll,
        location: location,
        contact: contact,
        ptt: ptt,
        mimetype: mimetype,
        fileName: fileName
    };

    // 2. Envia via Controller (Baileys)
    const sentMsg = await whatsappController.sendMessage(sessionId, to, payload);
    
    // 3. Salva no Banco (Para manter histórico de saída)
    if (companyId) {
        const remoteJid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        const phone = to.split('@')[0];
        
        let leadId = null;
        const { data: lead } = await supabase.from("leads").select("id").eq("phone", phone).eq("company_id", companyId).maybeSingle();
        if (lead) leadId = lead.id;

        // Formata o conteúdo visual para o banco
        let displayContent = text || caption || `[${payload.type}]`;
        
        if (payload.type === 'poll' && poll) displayContent = JSON.stringify(poll);
        else if (payload.type === 'location' && location) displayContent = JSON.stringify(location);
        else if (payload.type === 'contact' && contact) displayContent = JSON.stringify(contact);
        else if (payload.type === 'pix') displayContent = text; // Pix é texto no final das contas

        await supabase.from("messages").insert({
            company_id: companyId,
            lead_id: leadId,
            session_id: sessionId,
            remote_jid: remoteJid,
            whatsapp_id: sentMsg?.key?.id || `sent-${Date.now()}`,
            from_me: true,
            message_type: payload.type, // Salva o tipo correto no banco
            content: displayContent,
            media_url: url, // Salva URL se houver
            status: "sent",
            created_at: new Date()
        });
    }

    res.json({ success: true, id: sentMsg?.key?.id });

  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error);
    res.status(500).json({ error: "Falha no envio: " + error.message });
  }
});

router.post("/campaigns/send", createCampaign);

export default router;
