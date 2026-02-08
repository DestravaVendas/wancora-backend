
import express from "express";
import { createCampaign } from "../controllers/campaignController.js"; 
import { sendAppointmentConfirmation } from '../controllers/appointmentController.js';
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// --- ROTAS PÚBLICAS / SERVER-TO-SERVER ---
// (Não exigem Token de Usuário, pois são chamadas pelo próprio sistema ou webhooks)

// Confirmações de Agenda (Acionado pelo Next.js Server Action)
router.post('/appointments/confirm', sendAppointmentConfirmation);

// --- ROTAS PROTEGIDAS (DASHBOARD) ---
router.use(requireAuth);

// Campanhas em Massa
router.post("/campaigns/send", createCampaign);

export default router;
