
import express from "express";
import { connectDrive, callbackDrive, listFiles, syncNow, sendFileToContact } from "../controllers/cloudController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// ==============================================================================
// 🔓 ZONA PÚBLICA (CRÍTICO: NÃO MOVER)
// O Google redireciona o navegador para cá. Navegadores NÃO enviam token JWT no Header.
// ==============================================================================
router.get("/google/callback", callbackDrive);


// ==============================================================================
// 🔒 ZONA PROTEGIDA (REQUER LOGIN)
// Tudo abaixo desta linha exige Header 'Authorization: Bearer ...'
// ==============================================================================
// Aplica o middleware apenas para as rotas abaixo
router.use(requireAuth);

router.post("/google/connect", connectDrive);
router.post("/google/list", listFiles);
router.post("/google/sync", syncNow);
router.post("/google/send-to-whatsapp", sendFileToContact);

export default router;
