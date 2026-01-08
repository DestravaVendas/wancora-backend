import express from "express";
import * as whatsappController from "./controllers/whatsappController.js";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Rota para Iniciar Sessão
router.post("/session/start", async (req, res) => {
  const { sessionId, companyId } = req.body;
  try {
    await whatsappController.startSession(sessionId, companyId);
    res.status(200).json({ message: "Iniciando sessão..." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rota para Status/QR Code
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

// Rota para Enviar Mensagem (CORRIGIDA)
router.post("/message/send", async (req, res) => {
  const { sessionId, to, text, companyId } = req.body;
  try {
    // 1. Envia via WhatsApp (Baileys)
    await whatsappController.sendMessage(sessionId, to, text);
    
    // 2. Busca o ID do Lead para salvar no banco corretamente
    // (Se o lead não existir, a gente ignora o log ou cria um 'ghost lead'. 
    // Por segurança, vamos buscar apenas.)
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("phone", to) // 'to' é o número
      .eq("company_id", companyId)
      .single();

    if (lead) {
      // 3. Salva no histórico com o UUID correto
      await supabase.from("messages").insert({
        company_id: companyId,
        lead_id: lead.id, // <--- CORREÇÃO: Usando UUID
        direction: "outbound",
        type: "text",
        content: text,
        status: "sent"
      });
    } else {
        console.warn(`Mensagem enviada para ${to}, mas lead não encontrado no banco para salvar histórico.`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
