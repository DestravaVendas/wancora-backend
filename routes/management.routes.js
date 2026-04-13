
import express from "express";
import { 
    createGroup, updateGroup, getGroupMetadata,
    createCommunity, 
    syncCatalog,
    triggerStressTest,
    triggerAITest,
    getSyncStatus,      // 🛡️ Import adicionado
    refreshContactPic   // 🛡️ Import adicionado
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

// 🛡️ Correção: chamando a função direto e sem o authMiddleware (pois o router.use(requireAuth) já protege todas as rotas abaixo)
router.get('/instances/:sessionId/sync-status', getSyncStatus);

// 🛡️ [NOVO] Rota para Refresh Manual de Foto de Perfil
router.post('/contact/refresh-pic', refreshContactPic);

export default router;
