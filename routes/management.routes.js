
import express from "express";
import { 
    createGroup, updateGroup, createChannel, deleteChannel,
    createCommunity, searchChannels, followChannel,
    postStatus, updateProfile, syncCatalog
} from "../controllers/whatsappController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

// Grupos
router.post("/group/create", createGroup);
router.post("/group/update", updateGroup); 

// Comunidades (Novo)
router.post("/community/create", createCommunity);

// Canais (Novo)
router.post("/channel/create", createChannel);
router.post("/channel/delete", deleteChannel);
router.post("/channel/search", searchChannels);
router.post("/channel/follow", followChannel);

// Status / Stories (Novo)
router.post("/status/post", postStatus);

// Perfil (Novo)
router.post("/profile/update", updateProfile);

// Catálogo (Novo)
router.post("/catalog/sync", syncCatalog);

export default router;
