
import express from "express";
import { connectDrive, callbackDrive, listFiles, syncNow, sendFileToContact, uploadFileToDrive } from "../controllers/cloudController.js";
import { requireAuth } from "../middleware/auth.js";
import multer from 'multer';

const router = express.Router();

// Configuração do Multer (Armazena em memória para passar ao Drive Service)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // Limite 50MB
});

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

// Rota atualizada para usar Multer (Multipart Form Data)
router.post("/google/upload", upload.single('file'), uploadFileToDrive);

router.post("/google/send-to-whatsapp", sendFileToContact);

export default router;
