
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import mime from 'mime-types';
import pino from 'pino';
import sharp from 'sharp'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'silent' });

export const handleMediaUpload = async (rawMsg, companyId) => {
    try {
        // 1. Sanitização: Desenrola a mensagem para acessar o conteúdo real (ViewOnce, Ephemeral, etc)
        const msg = unwrapMessage(rawMsg);

        // PATCH: User-Agent Genérico para evitar bloqueio no download
        const downloadOptions = {
            options: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Referer': 'https://web.whatsapp.com/',
                    'Origin': 'https://web.whatsapp.com/'
                },
                timeout: 30000 // Aumentado para 30s para vídeos maiores
            }
        };

        // Download do Buffer
        let buffer = await downloadMediaMessage(
            msg,
            'buffer',
            downloadOptions,
            { logger, reuploadRequest: msg.updateMediaMessage }
        );

        if (!buffer) return null;

        // --- Detecção de Tipo ---
        let mimeType = 'application/octet-stream';
        const messageType = Object.keys(msg.message)[0];

        if (messageType === 'imageMessage') mimeType = msg.message.imageMessage?.mimetype || 'image/jpeg';
        else if (messageType === 'audioMessage') mimeType = msg.message.audioMessage?.mimetype || 'audio/mp4';
        else if (messageType === 'videoMessage') mimeType = msg.message.videoMessage?.mimetype || 'video/mp4';
        else if (messageType === 'documentMessage') mimeType = msg.message.documentMessage?.mimetype || 'application/pdf';
        else if (messageType === 'stickerMessage') mimeType = 'image/webp';

        // --- OTIMIZAÇÃO COM SHARP (Apenas Imagens) ---
        // Se for imagem (exceto sticker que já vem otimizado ou gif animado), redimensiona
        if (mimeType.startsWith('image/') && messageType !== 'stickerMessage' && !mimeType.includes('gif')) {
            try {
                // Redimensiona para max 1280px de largura/altura (HD), converte para JPEG com qualidade 80
                // Isso previne que fotos de 10MB travem o storage ou o frontend
                buffer = await sharp(buffer)
                    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
                    .toFormat('jpeg', { quality: 80 })
                    .toBuffer();
                
                mimeType = 'image/jpeg'; // Força tipo para JPEG após conversão
            } catch (sharpError) {
                console.warn("[MEDIA] Falha na otimização Sharp, usando original:", sharpError.message);
            }
        }

        let ext = mime.extension(mimeType) || 'bin';
        // Normalização de extensões
        if (mimeType === 'audio/mp4' || mimeType.includes('audio')) ext = 'm4a';
        if (mimeType.includes('opus')) ext = 'ogg';
        if (mimeType === 'image/jpeg') ext = 'jpg';

        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        const filePath = companyId ? `${companyId}/${fileName}` : fileName;

        // Upload para Supabase Storage
        const { error } = await supabase.storage
            .from('chat-media')
            .upload(filePath, buffer, { contentType: mimeType, upsert: false });

        if (error) {
            if (!error.message.includes('Duplicate')) {
                 console.error("[MEDIA] Erro Upload Supabase:", error.message);
            }
            return null;
        }

        const { data } = supabase.storage.from('chat-media').getPublicUrl(filePath);
        return data.publicUrl;

    } catch (e) {
        const m = e.message || '';
        // Ignora erros comuns de mídia expirada ou não autorizada
        if (m.includes('403') || m.includes('401') || m.includes('404') || m.includes('410') || m.includes('timeout')) {
             return null; 
        }
        console.warn(`[MEDIA] Falha download genérica: ${m}`);
        return null;
    }
};
