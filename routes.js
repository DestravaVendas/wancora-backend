import express from "express";
import * as whatsappController from "./controllers/whatsappController.js";
import { createCampaign } from "./controllers/campaignController.js";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==============================================================================
// 1. ROTAS DE SESSÃO (CONEXÃO)
// ==============================================================================

router.post("/session/start", async (req, res) => {
  const { sessionId, companyId } = req.body;
  
  if (!sessionId || !companyId) {
    return res.status(400).json({ error: "Dados incompletos (sessionId/companyId faltando)" });
  }

  // IMPORTANTE: Não usamos 'await' no startSession para não travar a requisição HTTP.
  // O Frontend recebe "Iniciando..." imediatamente e o QR Code aparece depois via banco.
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

// ROTA VITAL: O Frontend chama isso a cada 2s para ver se o QR Code chegou
router.get("/session/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  
  // Consultamos direto o Supabase, pois é a "Fonte da Verdade"
  const { data, error } = await supabase
    .from("instances")
    .select("*")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ status: "not_found" });

  res.json(data);
});

// ==============================================================================
// 2. ROTAS DE MENSAGEM (MULTIMÍDIA + ANTI-ERRO)
// ==============================================================================

router.post("/message/send", async (req, res) => {
  const { sessionId, to, text, type, url, caption, options, companyId } = req.body;
  
  // Validação básica
  if (!sessionId || !to) {
      return res.status(400).json({ error: "SessionId e Destinatário (to) são obrigatórios" });
  }

  try {
    // 1. Monta o Payload Inteligente (Suporta Texto, Imagem, Áudio, Enquete)
    const payload = {
        type: type || 'text',
        content: text,
        url: url,
        caption: caption,
        values: options, // Para enquetes
        ptt: true        // Se for áudio, força ser "Voice Note" (microfone azul)
    };

    // 2. Envia via Controller (Baileys)
    const sentMsg = await whatsappController.sendMessage(sessionId, to, payload);
    
    // 3. Salva no Banco (Optimistic UI + Segurança)
    if (companyId) {
        const remoteJid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        const phone = to.split('@')[0];
        
        // Anti-Erro: Verifica se o lead existe antes de salvar a mensagem de saída
        let leadId = null;
        const { data: lead } = await supabase
            .from("leads")
            .select("id")
            .eq("phone", phone)
            .eq("company_id", companyId)
            .maybeSingle();
            
        if (lead) leadId = lead.id;

        // Formata o conteúdo para o histórico ficar legível
        let displayContent = text || caption || `[${payload.type}]`;
        if (payload.type === 'poll') displayContent = '📊 Enquete';

        await supabase.from("messages").insert({
            company_id: companyId,
            lead_id: leadId,
            session_id: sessionId,
            remote_jid: remoteJid,
            direction: "outbound",
            from_me: true,
            type: payload.type,
            content: displayContent,
            status: "sent", // Assumimos enviado pois o baileys não deu erro
            created_at: new Date()
        });
    }

    res.json({ success: true, id: sentMsg?.key?.id });

  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error);
    res.status(500).json({ error: "Falha no envio: " + error.message });
  }
});

// ==============================================================================
// 3. ROTAS DE CAMPANHA
// ==============================================================================
router.post("/campaigns/send", createCampaign);

export default router;
