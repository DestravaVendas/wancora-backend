
import express from "express";
import { createClient } from "@supabase/supabase-js";

// Controllers
import { startSession, deleteSession } from "./services/baileys/connection.js";
import { sendMessage, sendPollVote, sendReaction, deleteMessage } from "./controllers/whatsappController.js"; 
import { createCampaign } from "./controllers/campaignController.js"; 
import { sendAppointmentConfirmation } from './controllers/appointmentController.js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// ==============================================================================
// 1. GESTÃO DE SESSÃO (Conexão WhatsApp)
// ==============================================================================

// Iniciar Conexão / Gerar QR Code
router.post("/session/start", async (req, res) => {
  const { sessionId, companyId } = req.body;
  
  if (!sessionId || !companyId) {
    return res.status(400).json({ error: "Dados incompletos (sessionId/companyId faltando)" });
  }

  // Fire-and-forget: Não espera a conexão completar para responder o frontend.
  // O Frontend receberá atualizações via WebSocket na tabela 'instances'.
  startSession(sessionId, companyId).catch(err => {
    console.error(`❌ Erro fatal ao iniciar sessão ${sessionId}:`, err);
  });
  
  res.status(200).json({ message: "Processo de conexão iniciado." });
});

// Logout / Desconectar
router.post("/session/logout", async (req, res) => {
  const { sessionId, companyId } = req.body;
  try {
    await deleteSession(sessionId, companyId); // Passa companyId para limpeza correta
    
    // Força atualização visual imediata no banco para o Frontend reagir
    await supabase.from("instances")
        .update({ status: 'disconnected', qrcode_url: null })
        .eq('session_id', sessionId)
        .eq('company_id', companyId);

    res.json({ message: "Sessão desconectada com sucesso." });
  } catch (error) {
    console.error("Erro no logout:", error);
    res.status(500).json({ error: error.message });
  }
});

// Status (Polling Fallback - usado principalmente por ferramentas externas)
router.get("/session/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { data, error } = await supabase.from("instances").select("*").eq("session_id", sessionId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ status: "not_found" });
  res.json(data);
});

// ==============================================================================
// 2. MENSAGERIA (Envio e Interação)
// ==============================================================================

// Enviar Mensagem (Texto, Mídia, Enquete, etc.)
router.post("/message/send", async (req, res) => {
  const { 
      sessionId, to, text, type, url, caption, 
      poll, location, contact, ptt, mimetype, fileName, companyId 
  } = req.body;
  
  if (!sessionId || !to) {
      return res.status(400).json({ error: "SessionId e Destinatário são obrigatórios" });
  }

  try {
    // Normaliza Payload para o Sender Service
    const payload = {
        sessionId,
        to,
        type: type || 'text',
        content: text, // O service usa 'content' como campo principal de texto
        url, caption, poll, location, contact, ptt, mimetype, fileName
    };

    // 1. Envio via Baileys
    const sentMsg = await sendMessage(payload);
    
    // 2. Salvamento Otimista (Optimistic Save)
    // Salva no banco imediatamente após o envio ter sucesso, sem esperar o Webhook "upsert" do Baileys.
    // Isso garante que a mensagem apareça no chat instantaneamente para o usuário.
    if (companyId && sentMsg?.key) {
        const remoteJid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        
        // Busca Lead ID para vincular (se existir)
        let leadId = null;
        const phoneClean = remoteJid.split('@')[0];
        const { data: lead } = await supabase.from("leads").select("id").eq("phone", phoneClean).eq("company_id", companyId).maybeSingle();
        if (lead) leadId = lead.id;

        // Formata conteúdo para exibição no histórico antes do processamento final
        let displayContent = text || caption || `[${payload.type}]`;
        
        if (payload.type === 'poll' && poll) displayContent = JSON.stringify(poll);
        else if (payload.type === 'location' && location) displayContent = JSON.stringify(location);
        else if (payload.type === 'contact' && contact) displayContent = JSON.stringify(contact);
        else if (payload.type === 'pix') displayContent = text; // Pix mostra a chave

        await supabase.from("messages").upsert({
            company_id: companyId,
            lead_id: leadId,
            session_id: sessionId,
            remote_jid: remoteJid,
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
router.post("/message/vote", async (req, res) => {
    const { companyId, sessionId, remoteJid, pollId, optionId } = req.body;
    if(!pollId || optionId === undefined) return res.status(400).json({ error: "PollId e OptionId obrigatórios" });

    try {
        await sendPollVote(sessionId, companyId, remoteJid, pollId, optionId);
        res.json({ success: true });
    } catch (error) {
        console.error("Erro ao votar:", error);
        res.status(500).json({ error: error.message });
    }
});

// Reagir (Emoji)
router.post("/message/react", async (req, res) => {
    const { sessionId, companyId, remoteJid, msgId, reaction } = req.body;
    try {
        await sendReaction(sessionId, companyId, remoteJid, msgId, reaction);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Deletar Mensagem (Revoke/Delete for me)
router.post("/message/delete", async (req, res) => {
    const { sessionId, companyId, remoteJid, msgId, everyone } = req.body;
    try {
        await deleteMessage(sessionId, companyId, remoteJid, msgId, everyone);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==============================================================================
// 3. MÓDULOS ESPECIAIS (Campanhas & Agenda)
// ==============================================================================

router.post("/campaigns/send", createCampaign);
router.post('/appointments/confirm', sendAppointmentConfirmation);

export default router;
