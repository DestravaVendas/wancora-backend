import express from "express";
import * as whatsappController from "./controllers/whatsappController.js";
import { createCampaign } from "./controllers/campaignController.js";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- ROTAS DE SESSÃO (CONEXÃO) ---

router.post("/session/start", async (req, res) => {
  const { sessionId, companyId } = req.body;
  
  if (!sessionId || !companyId) {
      return res.status(400).json({ error: "sessionId e companyId são obrigatórios" });
  }

  console.log(`[ROUTE] Iniciando sessão: ${sessionId} (Empresa: ${companyId})`);

  try {
    // Inicia em background para não travar a resposta HTTP (Evita Timeout no Frontend)
    whatsappController.startSession(sessionId, companyId).catch(err => {
        console.error("❌ [BACKGROUND ERROR] Erro fatal ao iniciar sessão:", err);
    });
    
    // Responde rápido para o Frontend exibir "Iniciando..." e começar o polling
    res.status(200).json({ message: "Processo de início disparado." });
  } catch (error) {
    console.error("[ROUTE ERROR]", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/session/logout", async (req, res) => {
  const { sessionId, companyId } = req.body;
  try {
    // Usa deleteSession conforme definido no controller atualizado
    await whatsappController.deleteSession(sessionId, companyId);
    res.json({ message: "Sessão desconectada com sucesso." });
  } catch (error) {
    console.error("Erro ao desconectar:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/session/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  
  // Busca status no banco (Supabase) pois o controller é stateless em serverless
  const { data, error } = await supabase
    .from("instances")
    .select("*")
    .eq("session_id", sessionId)
    .single();

  if (error) return res.status(404).json({ error: "Sessão não encontrada" });
  res.json(data);
});

// --- ROTAS DE MENSAGEM ---

router.post("/message/send", async (req, res) => {
  const { sessionId, to, text, companyId } = req.body;
  
  try {
    await whatsappController.sendMessage(sessionId, to, text);
    
    // Log de mensagem enviada (Opcional: Verifica se é lead para salvar no histórico)
    if (companyId && to) {
        // Normaliza telefone para busca (remove sufixos se houver)
        const phoneSearch = to.split('@')[0];
        
        const { data: lead } = await supabase
          .from("leads")
          .select("id")
          .eq("phone", phoneSearch) 
          .eq("company_id", companyId)
          .single();

        if (lead) {
          await supabase.from("messages").insert({
            company_id: companyId,
            lead_id: lead.id,
            direction: "outbound",
            type: "text",
            content: text,
            status: "sent",
            remote_jid: to.includes('@') ? to : `${to}@s.whatsapp.net` // Importante para o chat listar corretamente
          });
        }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- ROTAS DE CAMPANHA ---
router.post("/campaigns/send", createCampaign);

export default router;
