import express from "express";
import * as whatsappController from "./controllers/whatsappController.js";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

router.post("/session/start", async (req, res) => {
  const { sessionId, companyId } = req.body;
  console.log(`[ROUTE] Recebido pedido de start: Session ${sessionId}, Company ${companyId}`);
  
  if (!sessionId || !companyId) {
      return res.status(400).json({ error: "sessionId e companyId são obrigatórios" });
  }

  try {
    // Não usamos 'await' aqui de propósito para não travar a resposta HTTP
    // Mas chamamos a função para iniciar o processo em background
    whatsappController.startSession(sessionId, companyId).catch(err => {
        console.error("[BACKGROUND ERROR] Erro fatal no controller:", err);
    });
    
    res.status(200).json({ message: "Iniciando sessão..." });
  } catch (error) {
    console.error("[ROUTE ERROR]", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/session/logout", async (req, res) => {
  const { sessionId, companyId } = req.body;
  try {
    await whatsappController.deleteSession(sessionId, companyId);
    res.json({ message: "Sessão desconectada e limpa com sucesso." });
  } catch (error) {
    console.error("Erro ao desconectar:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/session/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { data, error } = await supabase
    .from("instances")
    .select("*")
    .eq("session_id", sessionId)
    .single();

  if (error) return res.status(404).json({ error: "Sessão não encontrada" });
  res.json(data);
});

router.post("/message/send", async (req, res) => {
  const { sessionId, to, text, companyId } = req.body;
  try {
    await whatsappController.sendMessage(sessionId, to, text);
    
    // Log Opcional (Ghost Lead check)
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("phone", to) 
      .eq("company_id", companyId)
      .single();

    if (lead) {
      await supabase.from("messages").insert({
        company_id: companyId,
        lead_id: lead.id,
        direction: "outbound",
        type: "text",
        content: text,
        status: "sent"
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
