
import { generateAuthUrl, handleAuthCallback } from "../services/google/authService.js";
import { syncDriveFiles, uploadFile, getFileStream } from "../services/google/driveService.js";
import { sendMessage } from "../services/baileys/sender.js";
import { getSessionId } from "./whatsappController.js";
import { createClient } from "@supabase/supabase-js";
import fs from 'fs'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. Auth Flow
export const connectDrive = async (req, res) => {
    // FIX CRÍTICO: O companyId vem do body (enviado pelo frontend), validado pelo middleware.
    // req.user não tem companyId na raiz.
    const { companyId } = req.body; 

    console.log(`🔌 [CLOUD] Iniciando conexão Drive para empresa: ${companyId}`);

    if (!companyId) {
        console.error("❌ [CLOUD] Erro: CompanyID não fornecido no body da requisição.");
        return res.status(400).json({ error: "Company ID é obrigatório para conectar." });
    }

    try {
        const url = generateAuthUrl(companyId);
        console.log(`🔗 [CLOUD] URL de Auth gerada (State incluso): ${url.substring(0, 50)}...`);
        res.json({ url });
    } catch (e) {
        console.error("❌ [CLOUD] Erro ao gerar URL:", e);
        res.status(500).json({ error: e.message });
    }
};

export const callbackDrive = async (req, res) => {
    const { code, state } = req.query; // state = companyId
    
    // Logs de Diagnóstico para ver o que o Google mandou
    console.log(`📥 [CLOUD] Callback recebido.`);
    console.log(`   - Code: ${code ? 'Presente' : 'AUSENTE'}`);
    console.log(`   - State (CompanyId): ${state ? state : 'AUSENTE'}`);

    try {
        if (!code || !state) {
            throw new Error(`Parâmetros inválidos do Google. Code: ${!!code}, State: ${!!state}`);
        }
        
        console.log(`🔑 [GOOGLE] Processando troca de token para empresa: ${state}`);
        const userInfo = await handleAuthCallback(code, state);
        
        // Lógica Inteligente de Redirecionamento
        const host = req.get('host');
        let frontendBaseUrl;

        // Detecta se está rodando localmente ou em produção
        if (host.includes('localhost') || host.includes('127.0.0.1')) {
            frontendBaseUrl = 'http://localhost:3000';
        } else {
            // Tenta pegar do env, senão usa o hardcoded do Netlify
            frontendBaseUrl = process.env.FRONTEND_URL || 'https://wancora-crm.netlify.app';
        }

        if (frontendBaseUrl.endsWith('/')) frontendBaseUrl = frontendBaseUrl.slice(0, -1);
        
        const redirectUrl = `${frontendBaseUrl}/cloud?google=success&email=${encodeURIComponent(userInfo.email)}`;
        console.log(`➡️ [GOOGLE] Redirecionando usuário para: ${redirectUrl}`);
        
        res.redirect(redirectUrl);

    } catch (e) {
        console.error("❌ [GOOGLE] Erro Fatal no Callback:", e);
        res.status(500).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1 style="color: #ef4444;">Falha na Autenticação</h1>
                <p>Ocorreu um erro técnico ao processar o retorno do Google.</p>
                <div style="background: #f4f4f5; padding: 15px; border-radius: 8px; display: inline-block; margin: 20px 0; text-align: left; max-width: 80%;">
                    <strong>Erro Técnico:</strong><br/>
                    <code style="color: #c026d3;">${e.message}</code>
                </div>
                <br/>
                <p style="font-size: 12px; color: #666;">Dica: Tente conectar novamente clicando no botão do painel.</p>
                <a href="/" style="color: #3b82f6; text-decoration: none; font-weight: bold; margin-top: 20px; display: inline-block;">Voltar para Home</a>
            </div>
        `);
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
        };

        // Upload para Supabase Storage para gerar URL pública rápida para o Baileys
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
