
import express from "express";
import { createCampaign } from "../controllers/campaignController.js"; 
import { sendAppointmentConfirmation } from '../controllers/appointmentController.js';
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// Aplica segurança nas rotas de disparo
// Nota: Webhooks externos podem precisar de uma lógica diferente (API Key no Header), 
// mas para chamadas do Frontend, requireAuth é o ideal.
router.use(requireAuth);

// Campanhas em Massa
router.post("/campaigns/send", createCampaign);

// Confirmações de Agenda
router.post('/appointments/confirm', sendAppointmentConfirmation);

export default router;
