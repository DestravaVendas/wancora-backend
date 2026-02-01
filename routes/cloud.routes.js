
import express from "express";
import { connectDrive, callbackDrive, listFiles, syncNow, sendFileToContact } from "../controllers/cloudController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// ==============================================================================
// 🔓 ZONA PÚBLICA (CRÍTICO: NÃO MOVER)
// O Google redireciona o navegador para cá. Navegadores NÃO enviam token JWT no Header.
// Esta rota DEVE ficar antes de router.use(requireAuth).
// ==============================================================================
router.get("/google/callback", (req, res, next) => {
    console.log("🔗 [CLOUD] Callback do Google recebido. Processando...");
    next();
}, callbackDrive);


// ==============================================================================
// 🔒 ZONA PROTEGIDA (REQUER LOGIN)
// Tudo abaixo desta linha exige Header 'Authorization: Bearer ...'
// ==============================================================================
router.use(requireAuth);

router.post("/google/connect", connectDrive);
router.post("/google/list", listFiles);
router.post("/google/sync", syncNow);
router.post("/google/send-to-whatsapp", sendFileToContact);

export default router;
