
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { sendAppointmentConfirmation } from './controllers/appointmentController.js';

// Serviços Modulares
import { startSession, deleteSession } from "./services/baileys/connection.js";
import { sendMessage, sendPollVote, sendReaction } from "./controllers/whatsappController.js"; 

// Controller de Campanhas
import { createCampaign } from "./controllers/campaignController.js"; 

const router = express.Router();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// ==============================================================================
// 1. ROTAS DE SESSÃO
// ==============================================================================

router.post("/session/start", async (req, res) => {
  const { sessionId, companyId } = req.body;
  
  if (!sessionId || !companyId) {
    return res.status(400).json({ error: "Dados incompletos (sessionId/companyId faltando)" });
  }

  // Fire and forget: Não bloqueia a request esperando o QR Code
  startSession(sessionId, companyId).catch(err => {
    console.error(`❌ Erro fatal ao iniciar sessão ${sessionId}:`, err);
  });
  
  res.status(200).json({ message: "Iniciando processo de conexão..." });
});

router.post("/session/logout", async (req, res) => {
  const { sessionId, companyId } = req.body;
  try {
    await deleteSession(sessionId);
    // Atualiza status no banco para desconectado
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

router.get("/session/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { data, error } = await supabase.from("instances").select("*").eq("session_id", sessionId).maybeSingle();
  
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ status: "not_found" });
  
  res.json(data);
});

// ==============================================================================
// 2. ROTAS DE MENSAGEM
// ==============================================================================

router.post("/message/send", async (req, res) => {
  const { 
      sessionId, 
      to, 
      text, 
      type, 
      url, 
      caption, 
      poll,      
      location,  
      contact,   
      ptt,       
      mimetype,  
      fileName,  
      companyId 
  } = req.body;
  
  if (!sessionId || !to) {
      return res.status(400).json({ error: "SessionId e Destinatário (to) são obrigatórios" });
  }

  try {
    // 1. Payload Unificado
    const payload = {
        sessionId,
        to,
        type: type || 'text',
        content: text, // Service espera 'content'
        url: url,
        caption: caption,
        poll: poll,
        location: location,
        contact: contact,
        ptt: ptt,
        mimetype: mimetype,
        fileName: fileName
    };

    // 2. Envio (Baileys)
    const sentMsg = await sendMessage(sessionId, to, payload);
    
    // 3. Salvamento Manual (Log Otimista/Idempotente)
    if (companyId && sentMsg?.key) {
        const remoteJid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        const phone = remoteJid.split('@')[0];
        
        let leadId = null;
        const { data: lead } = await supabase.from("leads").select("id").eq("phone", phone).eq("company_id", companyId).maybeSingle();
        if (lead) leadId = lead.id;

        let displayContent = text || caption || `[${payload.type}]`;
        
        if (payload.type === 'poll' && poll) displayContent = JSON.stringify(poll);
        else if (payload.type === 'location' && location) displayContent = JSON.stringify(location);
        else if (payload.type === 'contact' && contact) displayContent = JSON.stringify(contact);
        else if (payload.type === 'pix') displayContent = text; 

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
        }, { 
            onConflict: 'remote_jid, whatsapp_id',
            ignoreDuplicates: false 
        });
    }

    res.json({ success: true, id: sentMsg?.key?.id });

  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error);
    res.status(500).json({ error: "Falha no envio: " + (error.message || error) });
  }
});

// --- Rota de Votação (Enquetes) ---
router.post("/message/vote", async (req, res) => {
    const { companyId, sessionId, remoteJid, pollId, optionId } = req.body;
    
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

// --- Rota de Reações (Emojis) ---
router.post("/message/react", async (req, res) => {
    const { sessionId, companyId, remoteJid, msgId, reaction } = req.body;

    if (!sessionId || !remoteJid || !msgId) {
         return res.status(400).json({ error: "Dados incompletos para reação (sessionId, remoteJid, msgId)." });
    }

    try {
        await sendReaction(sessionId, companyId, remoteJid, msgId, reaction);
        res.json({ success: true });
    } catch (error) {
        console.error("Erro ao reagir:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==============================================================================
// 3. ROTAS DE CAMPANHA
// ==============================================================================

router.post("/campaigns/send", createCampaign);

// --- MÓDULO AGENDAMENTO ---
router.post('/appointments/confirm', sendAppointmentConfirmation);

export default router;
