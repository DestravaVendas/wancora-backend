
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import mime from 'mime-types';
import pino from 'pino';
import sharp from 'sharp'; 
import axios from 'axios';


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

        // [ZERO BUFFER] Puxa a mídia como Stream de descriptografia direto do motor Baileys
        let mediaStream = await downloadMediaMessage(
            msg,
            'stream',
            downloadOptions,
            { logger, reuploadRequest: msg.updateMediaMessage }
        );

        if (!mediaStream) return null;

        // --- Detecção de Tipo ---
        let mimeType = 'application/octet-stream';
        const messageType = Object.keys(msg.message)[0];

        if (messageType === 'imageMessage') mimeType = msg.message.imageMessage?.mimetype || 'image/jpeg';
        else if (messageType === 'audioMessage') mimeType = msg.message.audioMessage?.mimetype || 'audio/mp4';
        else if (messageType === 'videoMessage') mimeType = msg.message.videoMessage?.mimetype || 'video/mp4';
        else if (messageType === 'documentMessage') mimeType = msg.message.documentMessage?.mimetype || 'application/pdf';
        else if (messageType === 'stickerMessage') mimeType = 'image/webp';

        let uploadStream = mediaStream;

        // --- OTIMIZAÇÃO COM SHARP ON-THE-FLY (Apenas Imagens) ---
        if (mimeType.startsWith('image/') && messageType !== 'stickerMessage' && !mimeType.includes('gif')) {
            try {
                // Instancia o transformador Sharp sem bufferizar
                const sharpTransformer = sharp()
                    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
                    .toFormat('jpeg', { quality: 80 });
                
                uploadStream = mediaStream.pipe(sharpTransformer);
                mimeType = 'image/jpeg'; 
            } catch (sharpError) {
                console.warn("[MEDIA] Falha no piping do Sharp, usando original:", sharpError.message);
                uploadStream = mediaStream;
            }
        }

        let ext = mime.extension(mimeType) || 'bin';
        // Normalização de extensões
        if (mimeType === 'audio/mp4' || mimeType.includes('audio')) ext = 'm4a';
        if (mimeType.includes('opus')) ext = 'ogg';
        if (mimeType === 'image/jpeg') ext = 'jpg';

        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        const filePath = companyId ? `${companyId}/${fileName}` : fileName;

        // Upload Direto Streaming POST (Bypass Buffer RAM)
        const uploadUrl = `${process.env.SUPABASE_URL}/storage/v1/object/chat-media/${filePath}`;
        
        try {
            await axios.post(uploadUrl, uploadStream, {
                headers: {
                    'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
                    'Content-Type': mimeType
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 60000 // Segura o Stream por 60s
            });
        } catch (axiosError) {
            if (!axiosError.message.includes('Duplicate')) {
                 console.error("[MEDIA] Erro Axios Stream Upload:", axiosError.message);
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
