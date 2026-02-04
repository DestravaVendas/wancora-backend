
import { generateAuthUrl, handleAuthCallback } from "../services/google/authService.js";
import { syncDriveFiles, uploadFile, getFileStream, getStorageQuota, createFolder, deleteFiles, searchLiveFiles, importFilesToCache, convertDocxToHtml } from "../services/google/driveService.js";
import { sendMessage } from "../services/baileys/sender.js";
import { getSessionId } from "./whatsappController.js";
import { createClient } from "@supabase/supabase-js";
import fs from 'fs'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ... (Códigos de Auth e Callback mantidos) ...
export const connectDrive = async (req, res) => {
    const { companyId } = req.body; 
    console.log(`🔌 [CLOUD] Iniciando conexão Drive para empresa: ${companyId}`);
    if (!companyId) return res.status(400).json({ error: "Company ID é obrigatório para conectar." });
    try {
        const url = generateAuthUrl(companyId);
        res.json({ url });
    } catch (e) {
        console.error("❌ [CLOUD] Erro ao gerar URL:", e);
        res.status(500).json({ error: e.message });
    }
};

export const callbackDrive = async (req, res) => {
    const { code, state } = req.query; 
    try {
        if (!code || !state) throw new Error(`Parâmetros inválidos do Google.`);
        const userInfo = await handleAuthCallback(code, state);
        syncDriveFiles(state).catch(err => console.error("Initial Sync Error:", err));
        const host = req.get('host');
        let frontendBaseUrl = (host.includes('localhost') || host.includes('127.0.0.1')) ? 'http://localhost:3000' : (process.env.FRONTEND_URL || 'https://wancora-crm.netlify.app');
        if (frontendBaseUrl.endsWith('/')) frontendBaseUrl = frontendBaseUrl.slice(0, -1);
        res.redirect(`${frontendBaseUrl}/cloud?google=success&email=${encodeURIComponent(userInfo.email)}`);
    } catch (e) {
        res.status(500).send(`Erro na autenticação: ${e.message}`);
    }
};

export const listFiles = async (req, res) => {
    const { companyId } = req.body;
    const { folderId } = req.query;
    try {
        let query = supabase.from('drive_cache').select('*').eq('company_id', companyId);
        if (folderId) query = query.eq('parent_id', folderId);
        else query = query.is('parent_id', null); 

        let { data: cached } = await query;

        // Se cache vazio (Cold Start), força sync. Se não, apenas retorna e sync em background.
        if ((!cached || cached.length === 0) && !folderId) {
             await syncDriveFiles(companyId, folderId);
             const { data: refreshed } = await supabase.from('drive_cache').select('*').eq('company_id', companyId).is('parent_id', null);
             cached = refreshed;
        } else {
             syncDriveFiles(companyId, folderId).catch(() => {});
        }

        res.json({ files: cached || [], source: 'hybrid' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// [NOVO] Busca ao Vivo no Google Drive
export const searchDrive = async (req, res) => {
    const { companyId, query } = req.body;
    if (!query) return res.status(400).json({ error: "Query vazia." });
    try {
        const files = await searchLiveFiles(companyId, query);
        res.json({ files });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// [NOVO] Importar Arquivos Selecionados
export const importDriveFiles = async (req, res) => {
    const { companyId, files } = req.body; // files é array de objetos Google File
    try {
        const count = await importFilesToCache(companyId, files);
        res.json({ success: true, count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// [NOVO] Converter DOCX/GDoc para HTML
export const convertDocument = async (req, res) => {
    const { companyId, fileId } = req.body;
    try {
        const result = await convertDocxToHtml(companyId, fileId);
        res.json({ success: true, ...result });
    } catch (e) {
        console.error("Erro conversão:", e);
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
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
};
