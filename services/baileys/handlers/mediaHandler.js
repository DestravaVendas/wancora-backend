
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';
import pino from 'pino';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'silent' });

/**
 * Faz o download da mídia da mensagem e upload para o Supabase.
 * Retorna a URL pública.
 */
export const handleMediaUpload = async (msg, companyId) => {
    try {
        // PATCH 403: Headers completos simulando navegador real
        // O WhatsApp valida User-Agent e Referer rigorosamente agora
        const downloadOptions = {
            options: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Referer': 'https://web.whatsapp.com/',
                    'Origin': 'https://web.whatsapp.com/',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin'
                },
                timeout: 60000 // 60s timeout
            }
        };

        const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            downloadOptions,
            { logger, reuploadRequest: msg.updateMediaMessage }
        );

        if (!buffer) return null;

        // Determina tipo e extensão
        let mimeType = 'application/octet-stream';
        const messageType = Object.keys(msg.message)[0];

        if (messageType === 'imageMessage') mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
        else if (messageType === 'audioMessage') mimeType = msg.message.audioMessage.mimetype || 'audio/mp4';
        else if (messageType === 'videoMessage') mimeType = msg.message.videoMessage.mimetype || 'video/mp4';
        else if (messageType === 'documentMessage') mimeType = msg.message.documentMessage.mimetype || 'application/pdf';
        else if (messageType === 'stickerMessage') mimeType = 'image/webp';

        // Correção de Extensão para Audio (WhatsApp manda ogg, navegador prefere mp4/mp3 container)
        let ext = mime.extension(mimeType) || 'bin';
        if (mimeType === 'audio/mp4') ext = 'm4a';

        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        const filePath = companyId ? `${companyId}/${fileName}` : fileName;

        // Upload Supabase Storage
        const { error } = await supabase.storage
            .from('chat-media')
            .upload(filePath, buffer, { contentType: mimeType, upsert: false });

        if (error) {
            console.error("[MEDIA] Erro Upload Supabase:", error.message);
            return null;
        }

        const { data } = supabase.storage.from('chat-media').getPublicUrl(filePath);
        return data.publicUrl;

    } catch (e) {
        // Silencia erros conhecidos para não poluir log
        const msg = e.message || '';
        if (msg.includes('403') || msg.includes('401')) {
             console.warn(`[MEDIA] Falha Download (${msg}) - Tentando novamente na próxima.`);
        } else {
             console.error("[MEDIA] Falha Genérica:", msg);
        }
        return null;
    }
};
