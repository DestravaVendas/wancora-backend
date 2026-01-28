
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';
import pino from 'pino';
import axios from 'axios'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'silent' });

/**
 * Faz o download da mídia da mensagem e upload para o Supabase.
 * Retorna a URL pública.
 */
export const handleMediaUpload = async (msg) => {
    try {
        // PATCH: User-Agent spoofing completo para Chrome 120+ (Win10)
        // Isso é vital para evitar o erro 403 Forbidden do servidor de mídia do WhatsApp
        const downloadOptions = {
            options: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Referer': 'https://web.whatsapp.com/',
                    'Origin': 'https://web.whatsapp.com/'
                },
                // Timeout estendido para vídeos grandes
                timeout: 90000 
            }
        };

        // Baileys Download (Decriptação AES-256-CTR automática)
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
        // Tratamento de Erros Específicos
        const status = e?.response?.status || e?.statusCode;
        if (status === 403) {
             console.error("[MEDIA] Erro 403 (Bloqueio WA). O User-Agent pode estar desatualizado.");
        } else if (status === 401) {
             console.error("[MEDIA] Erro 401 (Não Autorizado). A URL de mídia expirou.");
        } else if (!e.message?.includes('404')) {
             console.error("[MEDIA] Falha no processamento:", e.message);
        }
        return null;
    }
};
