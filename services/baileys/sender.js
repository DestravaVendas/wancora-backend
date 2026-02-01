
import { sessions } from './connection.js';
import { delay, generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import { normalizeJid } from '../../utils/wppParsers.js';
import { convertAudioToOpus } from '../../utils/audioConverter.js';
import { transcribeAudio } from '../../services/ai/transcriber.js';
import { getFileBuffer } from '../../services/google/driveService.js';
import { createClient } from "@supabase/supabase-js";
import sharp from 'sharp';
import axios from 'axios';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// Helper para converter imagem em Sticker WebP (512x512)
const convertToSticker = async (url) => {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);

    return await sharp(buffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }) 
        .toFormat('webp')
        .toBuffer();
};

// Helper para gerar Thumbnail JPEG (Pequena) para Rich Link
const generateThumbnail = async (url) => {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        
        // WhatsApp exige thumbnail pequena e leve (< 10KB idealmente)
        return await sharp(buffer)
            .resize(300, 157, { fit: 'cover' }) // Proporção aproximada de link preview
            .jpeg({ quality: 60 })
            .toBuffer();
    } catch (e) {
        console.error("[SENDER] Falha ao gerar thumbnail:", e.message);
        return null;
    }
};

export const sendMessage = async ({
    sessionId,
    to,
    type = 'text',
    content,
    url,
    caption,
    fileName,
    mimetype,
    ptt = false,
    poll,
    location,
    contact,
    product,
    card,
    driveFileId, // [NOVO] ID do arquivo na tabela drive_cache (ou Google ID)
    companyId 
}) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sock) throw new Error(`Sessão ${sessionId} não encontrada.`);

    const sock = session.sock;
    const jid = normalizeJid(to);

    try {
        // [NOVO] Lógica de Drive Streaming
        // Se vier um driveFileId, baixamos o arquivo e sobrescrevemos os parâmetros de envio
        if (driveFileId && companyId) {
            console.log(`☁️ [SENDER] Buscando arquivo do Drive: ${driveFileId}`);
            try {
                // Busca ID real do Google se for UUID do Supabase
                let realGoogleId = driveFileId;
                if (driveFileId.length === 36) { // UUID check simples
                     const { data: fileData } = await supabase.from('drive_cache').select('google_id').eq('id', driveFileId).single();
                     if (fileData) realGoogleId = fileData.google_id;
                }

                const driveData = await getFileBuffer(companyId, realGoogleId);
                
                if (driveData.isLargeFile) {
                    // Fallback para Link se for muito grande
                    type = 'text';
                    content = `📁 *Arquivo Grande (${Math.round(driveData.size / 1024 / 1024)}MB)*\n\nO arquivo solicitada é muito grande para enviar por aqui. Acesse pelo link:\n${driveData.link}`;
                } else {
                    // Modo Streaming Nativo
                    const mime = driveData.mimeType;
                    fileName = driveData.fileName;
                    mimetype = mime;
                    
                    // Mapeia MIME do Drive para Tipo do Baileys
                    if (mime.startsWith('image/')) {
                        type = 'image';
                        url = driveData.buffer; // Baileys aceita Buffer no campo 'url' ou 'image'
                    } else if (mime.startsWith('video/')) {
                        type = 'video';
                        url = driveData.buffer;
                    } else if (mime.startsWith('audio/')) {
                        type = 'audio';
                        url = driveData.buffer;
                        ptt = false; // Áudio de arquivo, não PTT
                    } else {
                        type = 'document';
                        url = driveData.buffer;
                    }
                }
            } catch (driveErr) {
                console.error("❌ [SENDER] Falha ao baixar do Drive:", driveErr);
                await sock.sendMessage(jid, { text: "⚠️ Desculpe, não consegui baixar o arquivo solicitado do Drive." });
                return;
            }
        }

        // Pausa Inicial Humanizada
        await delay(randomDelay(500, 1000));
        
        const presenceType = (type === 'audio' && ptt) ? 'recording' : 'composing';
        await sock.sendPresenceUpdate(presenceType, jid);

        let productionTime = 1000;
        if (type === 'text' && content) productionTime = Math.min(content.length * 50, 5000);
        else if (type === 'audio' || ptt) productionTime = randomDelay(2000, 4000);
        else if (type === 'sticker') productionTime = 1500;
        else if (type === 'card') productionTime = 2000;
        else if (driveFileId) productionTime = 2500; // Tempo de "upload" fake

        await delay(productionTime);
        await sock.sendPresenceUpdate('paused', jid);

        let sentMsg;
        
        // Ajuste: Baileys aceita Buffer diretamente nas chaves (image, video, document)
        // Se 'url' for um Buffer, o Baileys lida corretamente.

        switch (type) {
            case 'text':
                sentMsg = await sock.sendMessage(jid, { 
                    text: content || "",
                });
                break;

            case 'image':
                sentMsg = await sock.sendMessage(jid, { image: url, caption: caption });
                break;

            case 'video':
                sentMsg = await sock.sendMessage(jid, { video: url, caption: caption, gifPlayback: false });
                break;

            case 'audio':
                if (ptt && typeof url === 'string') { // Só converte se for URL, se for Buffer (Drive) assume que já é audio
                    try {
                        const { buffer, waveform, duration } = await convertAudioToOpus(url);
                        
                        sentMsg = await sock.sendMessage(jid, {
                            audio: buffer,
                            ptt: true, 
                            seconds: duration,
                            mimetype: 'audio/ogg; codecs=opus',
                            waveform: Buffer.from(waveform)
                        });

                        if (companyId) {
                            transcribeAudio(buffer, 'audio/ogg', companyId).then(text => {
                                if (text && sentMsg.key.id) {
                                    supabase.from('messages').update({ transcription: text }).eq('whatsapp_id', sentMsg.key.id).then();
                                }
                            });
                        }
                    } catch (conversionError) {
                        sentMsg = await sock.sendMessage(jid, { audio: { url }, ptt: false, mimetype: mimetype || 'audio/mp4' });
                    }
                } else {
                    // Áudio genérico (Buffer ou URL)
                    sentMsg = await sock.sendMessage(jid, { audio: url, ptt: false, mimetype: mimetype || 'audio/mp4' });
                }
                break;

            case 'document':
                sentMsg = await sock.sendMessage(jid, { document: url, mimetype: mimetype || 'application/pdf', fileName: fileName || 'documento', caption: caption });
                break;

            case 'sticker':
                try {
                    const stickerBuffer = typeof url === 'string' ? await convertToSticker(url) : url; // Se já vier buffer? Sharp lida.
                    sentMsg = await sock.sendMessage(jid, { sticker: stickerBuffer });
                } catch (stickerErr) {
                    sentMsg = await sock.sendMessage(jid, { sticker: url });
                }
                break;

            case 'poll':
                if (!poll || !poll.name || !poll.options) throw new Error("Dados da enquete inválidos");
                const cleanOptions = poll.options.map(opt => opt.trim()).filter(opt => opt.length > 0);
                if (cleanOptions.length < 2) throw new Error("Enquete precisa de pelo menos 2 opções válidas.");
                sentMsg = await sock.sendMessage(jid, {
                    poll: { name: poll.name.trim(), values: cleanOptions, selectableCount: Number(poll.selectableOptionsCount) || 1 }
                });
                break;

            case 'location':
                if (!location) throw new Error("Dados de localização inválidos");
                sentMsg = await sock.sendMessage(jid, { location: { degreesLatitude: location.latitude, degreesLongitude: location.longitude } });
                break;

            case 'contact':
                if (!contact || !contact.vcard) throw new Error("Dados de contato inválidos");
                sentMsg = await sock.sendMessage(jid, { contacts: { displayName: contact.displayName, contacts: [{ vcard: contact.vcard }] } });
                break;

            case 'product':
                if (!product || !product.productId) throw new Error("Produto inválido.");
                sentMsg = await sock.sendMessage(jid, { 
                    product: {
                        productImage: product.productImageCount ? { url: url || '' } : undefined,
                        productId: product.productId,
                        title: product.title || 'Produto',
                        description: product.description,
                        currencyCode: product.currencyCode || 'BRL',
                        priceAmount1000: product.priceAmount1000 || 0,
                        retailerId: "WhatsApp",
                        url: "", 
                        productImageCount: 1 
                    },
                    businessOwnerJid: sock.user.id 
                });
                break;

            case 'card':
                if (!card || !card.link) throw new Error("Card precisa de um link.");
                
                let thumbBuffer = undefined;
                if (card.thumbnailUrl) {
                    thumbBuffer = await generateThumbnail(card.thumbnailUrl);
                }

                // Rich Link Construction (O "Card" Seguro)
                sentMsg = await sock.sendMessage(jid, {
                    text: card.description ? `${card.title}\n\n${card.description}` : card.title,
                    contextInfo: {
                        externalAdReply: {
                            title: card.title,
                            body: card.description || "Clique para abrir",
                            thumbnail: thumbBuffer, // Buffer da imagem
                            sourceUrl: card.link,
                            mediaType: 1, // 1 = Imagem (Thumbnail), 2 = Vídeo
                            renderLargerThumbnail: true, // Força o card grande
                            showAdAttribution: true // Mostra etiqueta "Link" ou similar, opcional
                        }
                    }
                });
                break;

            default:
                sentMsg = await sock.sendMessage(jid, { text: content || "" });
        }

        return sentMsg;

    } catch (err) {
        console.error(`❌ [SENDER] Erro de envio para ${jid}:`, err.message);
        throw err;
    }
};
