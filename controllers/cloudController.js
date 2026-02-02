
import { generateAuthUrl, handleAuthCallback } from "../services/google/authService.js";
import { syncDriveFiles, uploadFile, getFileStream } from "../services/google/driveService.js";
import { sendMessage } from "../services/baileys/sender.js";
import { getSessionId } from "./whatsappController.js";
import { createClient } from "@supabase/supabase-js";
import fs from 'fs'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. Auth Flow
export const connectDrive = async (req, res) => {
    const { companyId } = req.body; 

    console.log(`🔌 [CLOUD] Iniciando conexão Drive para empresa: ${companyId}`);

    if (!companyId) {
        return res.status(400).json({ error: "Company ID é obrigatório para conectar." });
    }

    try {
        const url = generateAuthUrl(companyId);
        res.json({ url });
    } catch (e) {
        console.error("❌ [CLOUD] Erro ao gerar URL:", e);
        res.status(500).json({ error: e.message });
    }
};

export const callbackDrive = async (req, res) => {
    const { code, state } = req.query; // state = companyId
    
    try {
        if (!code || !state) {
            throw new Error(`Parâmetros inválidos do Google.`);
        }
        
        console.log(`🔑 [GOOGLE] Processando troca de token para empresa: ${state}`);
        const userInfo = await handleAuthCallback(code, state);
        
        // Dispara um sync inicial em background para popular o cache
        syncDriveFiles(state).catch(err => console.error("Initial Sync Error:", err));

        // Lógica de Redirecionamento
        const host = req.get('host');
        let frontendBaseUrl;

        if (host.includes('localhost') || host.includes('127.0.0.1')) {
            frontendBaseUrl = 'http://localhost:3000';
        } else {
            frontendBaseUrl = process.env.FRONTEND_URL || 'https://wancora-crm.netlify.app';
        }

        if (frontendBaseUrl.endsWith('/')) frontendBaseUrl = frontendBaseUrl.slice(0, -1);
        
        const redirectUrl = `${frontendBaseUrl}/cloud?google=success&email=${encodeURIComponent(userInfo.email)}`;
        res.redirect(redirectUrl);

    } catch (e) {
        console.error("❌ [GOOGLE] Erro Fatal no Callback:", e);
        res.status(500).send(`Erro na autenticação: ${e.message}`);
    }
};

// 2. File Operations
export const listFiles = async (req, res) => {
    const { companyId } = req.body;
    const { folderId } = req.query;

    try {
        // Tenta buscar do cache
        let query = supabase.from('drive_cache').select('*').eq('company_id', companyId);
        if (folderId) query = query.eq('parent_id', folderId);
        else query = query.is('parent_id', null); // Root

        let { data: cached } = await query;

        // FIX: Se o cache estiver vazio (Cold Start), força o sync AGORA antes de responder
        if ((!cached || cached.length === 0) && !folderId) {
            console.log("📭 [CLOUD] Cache vazio. Forçando sincronização...");
            await syncDriveFiles(companyId, folderId);
            // Re-busca após sync
            const { data: refreshed } = await supabase.from('drive_cache').select('*').eq('company_id', companyId).is('parent_id', null);
            cached = refreshed;
        } else {
            // Se já tem dados, faz sync em background (Stale-while-revalidate)
            syncDriveFiles(companyId, folderId).catch(err => console.error("Background Sync Error:", err.message));
        }

        res.json({ files: cached || [], source: 'hybrid' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

export const syncNow = async (req, res) => {
    const { companyId } = req.body;
    try {
        const files = await syncDriveFiles(companyId);
        res.json({ success: true, count: files.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// [ATUALIZADO] Upload via Multipart/Form-Data (Streaming/Buffer)
export const uploadFileToDrive = async (req, res) => {
    // Agora os campos vêm no req.body e o arquivo em req.file (graças ao Multer)
    const { companyId, name, folderId } = req.body;
    const file = req.file;

    if (!companyId || !file) {
        return res.status(400).json({ error: "Arquivo ou CompanyId ausentes." });
    }

    try {
        // O Multer já processou o arquivo para um buffer
        const fileData = await uploadFile(
            companyId, 
            file.buffer, 
            name || file.originalname, 
            file.mimetype, 
            folderId === 'null' ? null : folderId // FormData converte null para string 'null'
        );
        
        res.json({ success: true, file: fileData });
    } catch (e) {
        console.error("Erro Upload Drive:", e);
        res.status(500).json({ error: e.message });
    }
};

// 3. Send to WhatsApp
export const sendFileToContact = async (req, res) => {
    const { companyId, fileId, to, caption } = req.body;

    if (!fileId || !to) return res.status(400).json({ error: "FileId e Destinatário obrigatórios" });

    try {
        const sessionId = await getSessionId(companyId);
        if (!sessionId) return res.status(503).json({ error: "WhatsApp desconectado." });

        // Obtém Stream do Google
        const { stream, fileName, mimeType } = await getFileStream(companyId, fileId);

        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
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
        console.error("Erro Send Drive File:", e);
        res.status(500).json({ error: e.message });
    }
};
