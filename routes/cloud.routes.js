
import express from "express";
import { connectDrive, callbackDrive, listFiles, syncNow, sendFileToContact, uploadFileToDrive } from "../controllers/cloudController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// ==============================================================================
// 🔓 ZONA PÚBLICA
// ==============================================================================
router.get("/google/callback", callbackDrive);


// ==============================================================================
// 🔒 ZONA PROTEGIDA
// ==============================================================================
router.use(requireAuth);

router.post("/google/connect", connectDrive);
router.post("/google/list", listFiles);
router.post("/google/sync", syncNow);
router.post("/google/upload", uploadFileToDrive); // Nova Rota
router.post("/google/send-to-whatsapp", sendFileToContact);

export default router;
