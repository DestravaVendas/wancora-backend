
import express from "express";
import { connectDrive, callbackDrive, listFiles, syncNow, sendFileToContact } from "../controllers/cloudController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// --- ZONA PÚBLICA (CRÍTICO) ---
// O Google redireciona para cá sem Headers de Auth. Deve vir ANTES do requireAuth.
router.get("/google/callback", callbackDrive);

// --- ZONA PROTEGIDA ---
// Tudo abaixo desta linha exige Token JWT
router.use(requireAuth);

router.post("/google/connect", connectDrive);
router.post("/google/list", listFiles);
router.post("/google/sync", syncNow);
router.post("/google/send-to-whatsapp", sendFileToContact);

export default router;
