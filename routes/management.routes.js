
import express from "express";
import { createGroup, updateGroup, createChannel, deleteChannel } from "../controllers/whatsappController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

// Grupos
router.post("/group/create", createGroup);
router.post("/group/update", updateGroup); // Gerencia settings, participantes e invites

// Canais
router.post("/channel/create", createChannel);
router.post("/channel/delete", deleteChannel);

export default router;
