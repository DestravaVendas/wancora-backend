
import express from "express";
import { 
    connectDrive, callbackDrive, listFiles, syncNow, sendFileToContact, 
    uploadFileToDrive, getQuota, createNewFolder, deleteItems, emptyTrashItems,
    searchDrive, importDriveFiles, convertDocument, removeImportedFiles, downloadFileContent
} from "../controllers/cloudController.js";
import { requireAuth } from "../middleware/auth.js";
import multer from 'multer';

const router = express.Router();

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// ZONA PÚBLICA
router.get("/google/callback", callbackDrive);

// ZONA PROTEGIDA
router.use(requireAuth);

router.post("/google/connect", connectDrive);
router.post("/google/list", listFiles);
router.post("/google/sync", syncNow);
router.post("/google/quota", getQuota);
router.post("/google/create-folder", createNewFolder);
router.post("/google/delete", deleteItems);
router.post("/google/remove-import", removeImportedFiles); 
router.post("/google/empty-trash", emptyTrashItems);
router.post("/google/upload", upload.single('file'), uploadFileToDrive);
router.post("/google/send-to-whatsapp", sendFileToContact);

router.post("/google/search-live", searchDrive);
router.post("/google/import", importDriveFiles);
router.post("/google/download-content", downloadFileContent); // NOVO: Baixar para edição (Sheet)
router.post("/convert/docx", convertDocument);

export default router;
