
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { startSession, deleteSession } from "../services/baileys/connection.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Middleware de Auth
router.use(requireAuth);

// Iniciar Conexão / Gerar QR Code
router.post("/start", async (req, res) => {
  const { sessionId, companyId } = req.body;
  
  if (!sessionId || !companyId) {
    return res.status(400).json({ error: "Dados incompletos (sessionId/companyId faltando)" });
  }

  startSession(sessionId, companyId).catch(err => {
    console.error(`❌ Erro fatal ao iniciar sessão ${sessionId}:`, err);
  });
  
  res.status(200).json({ message: "Processo de conexão iniciado." });
});

// Logout / Desconectar
router.post("/logout", async (req, res) => {
  const { sessionId, companyId } = req.body;
  try {
    await deleteSession(sessionId, companyId);
    
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

// Status
router.get("/status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  // Apenas a empresa dona pode ver o status (validado pelo middleware se passarmos companyId na query, mas aqui é GET simples)
  // TODO: Melhorar validação de GET para checar se sessionId pertence à empresa do usuário
  const { data, error } = await supabase.from("instances").select("*").eq("session_id", sessionId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ status: "not_found" });
  res.json(data);
});

export default router;
