
import express from "express";
import { 
    createGroup, updateGroup, getGroupMetadata,
    createCommunity, 
    syncCatalog,
    triggerStressTest,
    triggerAITest
} from "../controllers/whatsappController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

// Grupos
router.post("/group/create", createGroup);
router.post("/group/update", updateGroup); 
router.post("/group/metadata", getGroupMetadata); // NOVO

// Comunidades
router.post("/community/create", createCommunity);

// Catálogo
router.post("/catalog/sync", syncCatalog);

// Testes de Stress e IA
router.post("/stress/campaign", triggerStressTest);
router.post("/stress/ai", triggerAITest);

router.get('/instances/:sessionId/sync-status', authMiddleware, whatsappController.getSyncStatus);

// 🛡️ [NOVO] Rota para Refresh Manual de Foto de Perfil
router.post('/contact/refresh-pic', authMiddleware, whatsappController.refreshContactPic);

export default router;
