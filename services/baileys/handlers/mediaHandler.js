
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';
import pino from 'pino';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'silent' });

export const handleMediaUpload = async (msg, companyId) => {
    try {
        // PATCH: User-Agent Genérico e Moderno para evitar bloqueio 403 do WhatsApp
        const downloadOptions = {
            options: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Referer': 'https://web.whatsapp.com/',
                    'Origin': 'https://web.whatsapp.com/'
                },
                // Timeout curto (15s) para falhar rápido e não travar o loop de histórico se a mídia estiver pesada/lenta
                timeout: 15000 
            }
        };

        const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            downloadOptions,
            { logger, reuploadRequest: msg.updateMediaMessage }
        );

        if (!buffer) return null;

        // --- Determinação de Tipo ---
        let mimeType = 'application/octet-stream';
        const messageType = Object.keys(msg.message)[0];

        if (messageType === 'imageMessage') mimeType = msg.message.imageMessage?.mimetype || 'image/jpeg';
        else if (messageType === 'audioMessage') mimeType = msg.message.audioMessage?.mimetype || 'audio/mp4';
        else if (messageType === 'videoMessage') mimeType = msg.message.videoMessage?.mimetype || 'video/mp4';
        else if (messageType === 'documentMessage') mimeType = msg.message.documentMessage?.mimetype || 'application/pdf';
        else if (messageType === 'stickerMessage') mimeType = 'image/webp';

        let ext = mime.extension(mimeType) || 'bin';
        if (mimeType === 'audio/mp4' || mimeType.includes('audio')) ext = 'm4a';
        if (mimeType.includes('opus')) ext = 'ogg';

        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        const filePath = companyId ? `${companyId}/${fileName}` : fileName;

        // Upload Supabase (Sem travar se der erro de duplicata)
        const { error } = await supabase.storage
            .from('chat-media')
            .upload(filePath, buffer, { contentType: mimeType, upsert: false });

        if (error) {
             // Ignora erro se arquivo já existe (idempotência)
            if (!error.message.includes('Duplicate')) {
                 console.error("[MEDIA] Erro Upload Supabase:", error.message);
            }
            return null;
        }

        const { data } = supabase.storage.from('chat-media').getPublicUrl(filePath);
        return data.publicUrl;

    } catch (e) {
        // Silencia erros 403/404/410 (Mídia expirada ou bloqueada)
        // Isso impede que o terminal fique cheio de logs inúteis e o sync prossiga
        const m = e.message || '';
        if (m.includes('403') || m.includes('401') || m.includes('404') || m.includes('410') || m.includes('timeout')) {
             return null; 
        }
        console.warn(`[MEDIA] Falha download genérica: ${m}`);
        return null;
    }
};
