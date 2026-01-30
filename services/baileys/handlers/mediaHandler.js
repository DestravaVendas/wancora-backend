
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';
import pino from 'pino';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'silent' });

export const handleMediaUpload = async (msg, companyId) => {
    try {
        // PATCH: User-Agent Genérico e Moderno
        // Removemos referências excessivas para evitar fingerprinting agressivo
        const downloadOptions = {
            options: {
                headers: {
                    'User-Agent': 'WhatsApp/2.2413.51 A', // Simula User-Agent nativo
                    'Referer': 'https://web.whatsapp.com/',
                    'Origin': 'https://web.whatsapp.com/'
                },
                timeout: 30000 // Timeout mais curto para falhar rápido e não travar fila
            }
        };

        const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            downloadOptions,
            { logger, reuploadRequest: msg.updateMediaMessage }
        );

        if (!buffer) return null;

        // --- LÓGICA DE EXTENSÃO (Mantida e Robusta) ---
        let mimeType = 'application/octet-stream';
        const messageType = Object.keys(msg.message)[0];

        // Mapeamento seguro
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

        // Upload
        const { error } = await supabase.storage
            .from('chat-media')
            .upload(filePath, buffer, { contentType: mimeType, upsert: false });

        if (error) {
            // Se der erro de "Duplicate", ignoramos (idempotência)
            if (!error.message.includes('Duplicate')) {
                 console.error("[MEDIA] Erro Upload Supabase:", error.message);
            }
            return null;
        }

        const { data } = supabase.storage.from('chat-media').getPublicUrl(filePath);
        return data.publicUrl;

    } catch (e) {
        // Tratamento silencioso de erros conhecidos
        const m = e.message || '';
        // 403/401/404/410 são erros de mídia expirada ou bloqueio. Não adianta tentar de novo imediatamente.
        if (m.includes('403') || m.includes('401') || m.includes('404') || m.includes('410')) {
             return null; // Mídia perdida/expirada
        }
        console.warn(`[MEDIA] Falha download (${m})`);
        return null;
    }
};
