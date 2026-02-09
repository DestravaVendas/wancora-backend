
import { generateAuthUrl, handleAuthCallback } from "../services/google/authService.js";
import { syncDriveFiles, uploadFile, getFileStream, getStorageQuota, createFolder, deleteFiles, searchLiveFiles, listRemoteFolder, importFilesToCache, convertDocxToHtml, emptyTrash, removeFilesFromCache, getFileBuffer } from "../services/google/driveService.js";
import { sendMessage } from "../services/baileys/sender.js";
import { getSessionId } from "./whatsappController.js";
import { createClient } from "@supabase/supabase-js";
import { Logger } from "../utils/logger.js"; // IMPORT LOGGER

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export const connectDrive = async (req, res) => {
    const { companyId } = req.body; 
    console.log(`🔌 [CLOUD] Iniciando conexão Drive para empresa: ${companyId}`);
    if (!companyId) return res.status(400).json({ error: "Company ID é obrigatório para conectar." });
    try {
        const url = generateAuthUrl(companyId);
        res.json({ url });
    } catch (e) {
        Logger.error('cloud', 'Erro ao gerar URL de Auth', { error: e.message, stack: e.stack }, companyId);
        res.status(500).json({ error: e.message });
    }
};

export const callbackDrive = async (req, res) => {
    const { code, state } = req.query; 
    try {
        if (!code || !state) throw new Error(`Parâmetros inválidos do Google.`);
        const userInfo = await handleAuthCallback(code, state);
        syncDriveFiles(state).catch(err => Logger.error('cloud', 'Initial Sync Error', { error: err.message, stack: err.stack }, state));
        const host = req.get('host');
        let frontendBaseUrl = (host.includes('localhost') || host.includes('127.0.0.1')) ? 'http://localhost:3000' : (process.env.FRONTEND_URL || 'https://wancora-crm.netlify.app');
        if (frontendBaseUrl.endsWith('/')) frontendBaseUrl = frontendBaseUrl.slice(0, -1);
        res.redirect(`${frontendBaseUrl}/cloud?google=success&email=${encodeURIComponent(userInfo.email)}`);
    } catch (e) {
        Logger.error('cloud', 'Callback Auth Failed', { error: e.message, query: req.query, stack: e.stack });
        res.status(500).send(`Erro na autenticação: ${e.message}`);
    }
};

export const listFiles = async (req, res) => {
    const { companyId } = req.body;
    const { folderId, isTrash } = req.query; 

    try {
        if (isTrash === 'true') {
            const trashFiles = await syncDriveFiles(companyId, null, true);
            return res.json({ files: trashFiles, source: 'live' });
        }

        // Modo Normal: Cache + Sync Background
        let query = supabase.from('drive_cache').select('*').eq('company_id', companyId);
        
        if (folderId && folderId !== 'null') query = query.eq('parent_id', folderId);
        else query = query.is('parent_id', null); 

        let { data: cached } = await query;

        // Se cache vazio, tenta sync imediato
        if ((!cached || cached.length === 0)) {
             const freshFiles = await syncDriveFiles(companyId, folderId === 'null' ? null : folderId);
             
             if (freshFiles && freshFiles.length > 0) {
                 cached = freshFiles.map(f => ({
                    id: f.id, 
                    google_id: f.id,
                    name: f.name,
                    mime_type: f.mimeType,
                    web_view_link: f.webViewLink,
                    thumbnail_link: f.thumbnailLink,
                    size: f.size,
                    is_folder: f.mimeType === 'application/vnd.google-apps.folder',
                    updated_at: f.modifiedTime
                 }));
             }
        } else {
             // Trigger sync background para limpar fantasmas
             syncDriveFiles(companyId, folderId === 'null' ? null : folderId).catch(() => {});
        }

        res.json({ files: cached || [], source: 'hybrid' });
    } catch (e) {
        Logger.error('cloud', 'Erro listFiles', { error: e.message, stack: e.stack }, companyId);
        res.status(500).json({ error: e.message });
    }
};

export const searchDrive = async (req, res) => {
    const { companyId, query } = req.body;
    if (!query) return res.status(400).json({ error: "Query vazia." });
    try {
        const files = await searchLiveFiles(companyId, query);
        res.json({ files });
    } catch (e) {
        Logger.error('cloud', 'Search Error', { error: e.message, query }, companyId);
        res.status(500).json({ error: e.message });
    }
};

export const listRemoteFiles = async (req, res) => {
    const { companyId, folderId } = req.body;
    try {
        const files = await listRemoteFolder(companyId, folderId);
        res.json({ files });
    } catch (e) {
        Logger.error('cloud', 'Remote List Error', { error: e.message, folderId }, companyId);
        res.status(500).json({ error: e.message });
    }
};

export const importDriveFiles = async (req, res) => {
    const { companyId, files, currentFolderId } = req.body; 
    
    try {
        const count = await importFilesToCache(companyId, files, currentFolderId);
        res.json({ success: true, count });
    } catch (e) {
        Logger.error('cloud', 'Erro Import Files', { error: e.message, stack: e.stack }, companyId);
        res.status(500).json({ error: e.message });
    }
};

export const convertDocument = async (req, res) => {
    const { companyId, fileId } = req.body;
    try {
        const result = await convertDocxToHtml(companyId, fileId);
        res.json({ success: true, ...result });
    } catch (e) {
        Logger.error('cloud', 'Erro Convert Docx', { error: e.message, fileId, stack: e.stack }, companyId);
        res.status(500).json({ error: e.message });
    }
};

export const downloadFileContent = async (req, res) => {
    const { companyId, fileId } = req.body;
    try {
        // Reutiliza getFileBuffer que já trata conversão de Google Sheets para XLSX
        const fileData = await getFileBuffer(companyId, fileId);
        
        if (fileData.isLargeFile) {
            return res.status(400).json({ error: "Arquivo muito grande para edição online." });
        }

        // Retorna como base64 para facilitar o transporte via JSON
        const base64 = fileData.buffer.toString('base64');
        
        res.json({ 
            success: true, 
            base64, 
            filename: fileData.fileName,
            mimeType: fileData.mimeType 
        });
    } catch (e) {
        Logger.error('cloud', 'Erro Download Content', { error: e.message, fileId, stack: e.stack }, companyId);
        res.status(500).json({ error: e.message });
    }
};

export const syncNow = async (req, res) => {
    const { companyId } = req.body;
    try {
        const files = await syncDriveFiles(companyId);
        res.json({ success: true, count: files.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
};

export const uploadFileToDrive = async (req, res) => {
    const { companyId, name, folderId } = req.body;
    const file = req.file;
    if (!companyId || !file) return res.status(400).json({ error: "Arquivo ou CompanyId ausentes." });

    try {
        const fileData = await uploadFile(companyId, file.buffer, name || file.originalname, file.mimetype, folderId === 'null' ? null : folderId);
        res.json({ success: true, file: fileData });
    } catch (e) { 
        Logger.error('cloud', 'Erro Upload', { error: e.message, stack: e.stack }, companyId);
        res.status(500).json({ error: e.message }); 
    }
};

export const getQuota = async (req, res) => {
    const { companyId } = req.body;
    try {
        const quota = await getStorageQuota(companyId);
        res.json({ success: true, quota });
    } catch (e) { res.status(500).json({ error: e.message }); }
};

export const createNewFolder = async (req, res) => {
    const { companyId, name, parentId } = req.body;
    try {
        const folder = await createFolder(companyId, name, parentId);
        res.json({ success: true, folder });
    } catch (e) { res.status(500).json({ error: e.message }); }
};

export const deleteItems = async (req, res) => {
    const { companyId, fileIds } = req.body;
    try {
        await deleteFiles(companyId, fileIds);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
};

export const removeImportedFiles = async (req, res) => {
    const { companyId, fileIds } = req.body;
    try {
        await removeFilesFromCache(companyId, fileIds);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
};

export const emptyTrashItems = async (req, res) => {
    const { companyId } = req.body;
    try {
        await emptyTrash(companyId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
};

export const sendFileToContact = async (req, res) => {
    const { companyId, fileId, to, caption } = req.body;
    if (!fileId || !to) return res.status(400).json({ error: "FileId e Destinatário obrigatórios" });

    try {
        const sessionId = await getSessionId(companyId);
        if (!sessionId) return res.status(503).json({ error: "WhatsApp desconectado." });

        const { stream, fileName, mimeType } = await getFileStream(companyId, fileId);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);

        let type = 'document';
        if (mimeType.startsWith('image/')) type = 'image';
        else if (mimeType.startsWith('video/')) type = 'video';
        else if (mimeType.startsWith('audio/')) type = 'audio';

        const payload = {
            sessionId,
            to,
            type,
            companyId,
            caption: caption || fileName,
            fileName: fileName,
            mimetype: mimeType,
        };

        const tempName = `temp_${Date.now()}_${fileName}`;
        await supabase.storage.from('chat-media').upload(`${companyId}/${tempName}`, buffer, { contentType: mimeType });
        const { data: publicData } = supabase.storage.from('chat-media').getPublicUrl(`${companyId}/${tempName}`);
        
        payload.url = publicData.publicUrl;
        await sendMessage(payload);

        res.json({ success: true, message: "Arquivo enviado para o WhatsApp." });
    } catch (e) { 
        Logger.error('cloud', 'Erro Send File to WA', { error: e.message, stack: e.stack }, companyId);
        res.status(500).json({ error: e.message }); 
    }
};
