
import express from "express";
import { connectDrive, callbackDrive, listFiles, syncNow, sendFileToContact } from "../controllers/cloudController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// Rotas Públicas (Callback do Google)
router.get("/google/callback", callbackDrive);

// Rotas Protegidas
router.use(requireAuth);

router.post("/google/connect", connectDrive);
router.post("/google/list", listFiles);
router.post("/google/sync", syncNow);
router.post("/google/send-to-whatsapp", sendFileToContact);

export default router;
