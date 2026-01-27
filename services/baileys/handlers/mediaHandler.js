
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';
import pino from 'pino';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'silent' });

// User-Agent Fixo para emular navegador real
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Faz o download da mídia da mensagem e upload para o Supabase.
 * Retorna a URL pública.
 */
export const handleMediaUpload = async (msg) => {
    try {
        // Baileys Download (Decriptação AES-256-CTR automática)
        // PATCH: Passamos 'options' com headers para o axios interno do Baileys
        const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            { 
                options: { 
                    headers: { 'User-Agent': BROWSER_UA } 
                } 
            },
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

        const ext = mime.extension(mimeType) || 'bin';
        const fileName = `chat_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;

        // Upload Supabase Storage
        const { error } = await supabase.storage
            .from('chat-media')
            .upload(fileName, buffer, { contentType: mimeType, upsert: false });

        if (error) {
            console.error("[MEDIA] Erro Upload Supabase:", error.message);
            return null;
        }

        const { data } = supabase.storage.from('chat-media').getPublicUrl(fileName);
        return data.publicUrl;

    } catch (e) {
        console.error("[MEDIA] Falha crítica no processamento:", e.message);
        return null;
    }
};
