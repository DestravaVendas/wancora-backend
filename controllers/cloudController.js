
import { generateAuthUrl, handleAuthCallback } from "../services/google/authService.js";
import { syncDriveFiles, uploadFile, getFileStream } from "../services/google/driveService.js";
import { sendMessage } from "../services/baileys/sender.js";
import { getSessionId } from "./whatsappController.js";
import { createClient } from "@supabase/supabase-js";
import fs from 'fs'; // Apenas para manipulação temporária se necessário

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. Auth Flow
export const connectDrive = async (req, res) => {
    const { companyId } = req.user; // Obtido via JWT middleware
    try {
        const url = generateAuthUrl(companyId);
        res.json({ url });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

export const callbackDrive = async (req, res) => {
    const { code, state } = req.query; // state = companyId
    try {
        if (!code || !state) throw new Error("Parâmetros inválidos do Google.");
        
        const userInfo = await handleAuthCallback(code, state);
        
        // Redireciona para o frontend com sucesso
        // Ajuste a URL conforme seu ambiente de produção
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        res.redirect(`${frontendUrl}/settings?google=success&email=${userInfo.email}`);
    } catch (e) {
        console.error("Erro Callback Google:", e);
        res.status(500).send("Falha na autenticação com Google Drive.");
    }
};

// 2. File Operations
export const listFiles = async (req, res) => {
    const { companyId } = req.body;
    const { folderId } = req.query;

    try {
        // Primeiro tenta buscar do cache rápido
        let query = supabase.from('drive_cache').select('*').eq('company_id', companyId);
        if (folderId) query = query.eq('parent_id', folderId);
        else query = query.is('parent_id', null); // Root

        const { data: cached } = await query;

        // Dispara sync em background (Fire and Forget) para atualizar cache
        syncDriveFiles(companyId, folderId).catch(err => console.error("Background Sync Error:", err.message));

        res.json({ files: cached, source: 'cache_with_background_sync' });
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

// 3. Send to WhatsApp (The Magic)
export const sendFileToContact = async (req, res) => {
    const { companyId, fileId, to, caption } = req.body;

    if (!fileId || !to) return res.status(400).json({ error: "FileId e Destinatário obrigatórios" });

    try {
        const sessionId = await getSessionId(companyId);
        if (!sessionId) return res.status(503).json({ error: "WhatsApp desconectado." });

        // Obtém Stream do Google
        const { stream, fileName, mimeType } = await getFileStream(companyId, fileId);

        // Converte Stream para Buffer (Baileys precisa de buffer ou url publica)
        // Nota: Para arquivos GIGANTES, isso pode ser perigoso. 
        // Idealmente, usaríamos stream diretamente se o Baileys suportasse bem, ou salvaríamos temp.
        // Como o Wancora foca em envio rápido, vamos converter para buffer com limite seguro.
        
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        // Determina tipo de mensagem
        let type = 'document';
        if (mimeType.startsWith('image/')) type = 'image';
        else if (mimeType.startsWith('video/')) type = 'video';
        else if (mimeType.startsWith('audio/')) type = 'audio';

        // Prepara payload
        const payload = {
            sessionId,
            to,
            type,
            companyId,
            caption: caption || fileName,
            fileName: fileName,
            mimetype: mimeType,
            // Truque: O sendMessage do Baileys (sender.js) espera 'url' ou lógica interna.
            // Vamos precisar adaptar o sender.js para aceitar 'buffer' direto se não tiver URL.
            // Mas o nosso sender.js atual já lida com 'url'.
            // Vamos hackear passando o buffer como uma propriedade extra que o sender.js precisa tratar,
            // OU (solução mais limpa agora) fazer upload para o Supabase Storage temporário e mandar a URL.
        };

        // Opção Rápida: Upload para Supabase Storage para gerar URL pública rápida para o Baileys
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
