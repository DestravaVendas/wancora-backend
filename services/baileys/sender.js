import { sessions } from './connection.js';
import { delay, generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import { normalizeJid } from '../../utils/wppParsers.js';
import { convertAudioToOpus } from '../../utils/audioConverter.js';
import { transcribeAudio } from '../../services/ai/transcriber.js';
import { getFileBuffer } from '../../services/google/driveService.js';
import { createClient } from "@supabase/supabase-js";
import { resolveJid } from '../crm/sync.js'; // 🛡️ [NOVO] Importa o resolvedor de LID
import sharp from 'sharp';
import axios from 'axios';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// 🛡️ [ANTI-BAN] Fila de Saída Global por Sessão
// Garante que uma sessão nunca envie duas mensagens simultaneamente, mesmo vindo de fontes diferentes (IA, Agenda, Manual).
const sendLocks = new Map();

/**
 * 🛡️ [ESTABILIDADE] Executa uma função garantindo que a sessão esteja travada.
 * Evita erros de "Bad MAC" e conflitos de estado no socket.
 */
export const executeLocked = async (sessionId, task) => {
    if (!sendLocks.has(sessionId)) {
        sendLocks.set(sessionId, Promise.resolve());
    }

    const currentLock = sendLocks.get(sessionId);
    const nextTask = currentLock.then(async () => {
        try {
            return await task();
        } catch (e) {
            console.error(`❌ [SENDER] Erro em tarefa travada (${sessionId}):`, e.message);
            throw e;
        }
    });

    sendLocks.set(sessionId, nextTask.catch(() => {}));
    return nextTask;
};

// 🛡️ NOVO: Função para enviar reações (Emojis)
export const sendReaction = async (sessionId, companyId, jid, messageId, emoji) => {
    return executeLocked(sessionId, async () => {
        const session = sessions.get(sessionId);
        if (!session || !session.sock) return;

        await session.sock.sendMessage(jid, {
            react: {
                text: emoji,
                key: {
                    remoteJid: jid,
                    id: messageId,
                    fromMe: false // Reage à mensagem do cliente
                }
            }
        });
    });
};

// 🛡️ NOVO: Função para forçar a visualização (visto azul) antes de responder
export const markMessageAsRead = async (sessionId, jid, messageId) => {
    return executeLocked(sessionId, async () => {
        const session = sessions.get(sessionId);
        if (!session || !session.sock) return;
        try {
            await session.sock.readMessages([{ remoteJid: jid, id: messageId }]);
        } catch (e) {
            console.error("[SENDER] Erro ao marcar como lido:", e.message);
        }
    });
};

// Helper para converter imagem em Sticker WebP (512x512) com Metadados EXIF
const convertToSticker = async (url) => {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    const buffer = Buffer.from(response.data);

    // [NATIVO] Usa wa-sticker-formatter para injetar metadados da Wancora
    const sticker = new Sticker(buffer, {
        pack: 'Wancora CRM',
        author: 'Wancora Team',
        type: StickerTypes.FULL,
        categories: ['🤩', '🎉'],
        id: 'wancora-sticker',
        quality: 70,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
    });

    return await sticker.toBuffer();
};

// Helper para gerar Thumbnail JPEG (Pequena) para Rich Link
const generateThumbnail = async (url) => {
    try {
        // Timeout de 5s para não travar o envio se a imagem for pesada ou lenta
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
        const buffer = Buffer.from(response.data);
        
        // WhatsApp exige thumbnail pequena e leve (< 10KB idealmente)
        return await sharp(buffer)
            .resize(300, 157, { fit: 'cover' }) // Proporção aproximada de link preview
            .jpeg({ quality: 60 })
            .toBuffer();
    } catch (e) {
        console.error("[SENDER] Falha ao gerar thumbnail (ignorando):", e.message);
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
    driveFileId, 
    companyId,
    timingConfig // [NOVO] Configuração de tempo { min_delay, max_delay, override_typing_time }
}) => {
    return executeLocked(sessionId, async () => {
        const session = sessions.get(sessionId);
        if (!session || !session.sock) throw new Error(`Sessão ${sessionId} não encontrada.`);

        const sock = session.sock;
        let jid = normalizeJid(to);

        // 🛡️ [FIX] Resolve LID antes de enviar para garantir que use o JID canônico se disponível
        if (jid.includes('@lid')) {
            const resolved = await resolveJid(jid, companyId);
            if (resolved && !resolved.includes('@lid')) {
                jid = resolved;
            }
        }

        try {
            // [ANTI-BAN] Verifica se a conexão ainda está ativa antes de simular comportamento
            if (!sock || !sock.user) {
                throw new Error("Conexão com WhatsApp perdida durante o processo de envio.");
            }

            // [FIX BRASIL] Validação de existência para corrigir 9º dígito
            if (jid.startsWith('55') && jid.includes('@s.whatsapp.net')) {
                try {
                    const [result] = await sock.onWhatsApp(jid);
                    if (result && result.exists) {
                        jid = result.jid; 
                    }
                } catch (e) {}
            }

            // [NOVO] Lógica de Drive Streaming
            if (driveFileId && companyId) {
                console.log(`☁️ [SENDER] Buscando arquivo do Drive: ${driveFileId}`);
                try {
                    let realGoogleId = driveFileId;
                    if (driveFileId.length === 36) { 
                         const { data: fileData } = await supabase.from('drive_cache').select('google_id').eq('id', driveFileId).single();
                         if (fileData) realGoogleId = fileData.google_id;
                    }

                    const driveData = await getFileBuffer(companyId, realGoogleId);
                    
                    if (driveData.isLargeFile) {
                        type = 'text';
                        content = `📁 *Arquivo Grande (${Math.round(driveData.size / 1024 / 1024)}MB)*\n\nO arquivo solicitada é muito grande para enviar por aqui. Acesse pelo link:\n${driveData.link}`;
                    } else {
                        const mime = driveData.mimeType;
                        fileName = driveData.fileName;
                        mimetype = mime;
                        
                        if (mime.startsWith('image/')) {
                            type = 'image';
                            url = driveData.buffer; 
                        } else if (mime.startsWith('video/')) {
                            type = 'video';
                            url = driveData.buffer;
                        } else if (mime.startsWith('audio/')) {
                            type = 'audio';
                            url = driveData.buffer;
                            ptt = false; 
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

            // --- CÁLCULO DE DELAY INTELIGENTE E SEGURO (ANTI-BAD MAC) ---
            const minDelay = timingConfig?.min_delay_seconds ? timingConfig.min_delay_seconds * 1000 : 2500;
            const maxDelay = timingConfig?.max_delay_seconds ? timingConfig.max_delay_seconds * 1000 : 4000;
            
            // Garante que max >= min 
            const safeMin = Math.max(minDelay, 1000); 
            const safeMax = Math.max(maxDelay, safeMin);
            
            await delay(randomDelay(Math.floor(safeMin * 0.5), Math.floor(safeMin * 0.8)));
            
            // 2. Simulação de Digitação (Typing Time)
            const presenceType = (type === 'audio' && ptt) ? 'recording' : 'composing';
            await sock.sendPresenceUpdate(presenceType, jid);

            let productionTime = 1000;
            
            // 🧠 A IA NO SENTINEL AGORA COMANDA O TEMPO EXATO DA DIGITAÇÃO
            if (timingConfig?.override_typing_time) {
                productionTime = timingConfig.override_typing_time;
            } else if (type === 'text' && content) {
                const charTime = content.length * 40;
                if (timingConfig) {
                     productionTime = randomDelay(minDelay, safeMax);
                     if (content.length > 200) productionTime = safeMax;
                } else {
                    productionTime = Math.min(charTime, 6000); 
                }
            }
            else if (type === 'audio' || ptt) productionTime = randomDelay(2000, 5000);
            else if (type === 'sticker') productionTime = 1000;
            else if (type === 'card') productionTime = 1500;
            else if (driveFileId) productionTime = 2500;

            await delay(productionTime);
            await sock.sendPresenceUpdate('paused', jid);

            let sentMsg;
            
            switch (type) {
                case 'text':
                    sentMsg = await sock.sendMessage(jid, { 
                        text: content || "",
                    });
                    break;

                case 'image':
                    sentMsg = await sock.sendMessage(jid, { image: { url: url }, caption: caption });
                    break;

                case 'video':
                    sentMsg = await sock.sendMessage(jid, { video: { url: url }, caption: caption, gifPlayback: false });
                    break;

                case 'audio':
                    if (ptt && typeof url === 'string') { 
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
                            sentMsg = await sock.sendMessage(jid, { audio: { url: url }, ptt: false, mimetype: mimetype || 'audio/mp4' });
                        }
                    } else {
                        sentMsg = await sock.sendMessage(jid, { audio: { url: url }, ptt: false, mimetype: mimetype || 'audio/mp4' });
                    }
                    break;

                case 'document':
                    sentMsg = await sock.sendMessage(jid, { document: { url: url }, mimetype: mimetype || 'application/pdf', fileName: fileName || 'documento', caption: caption });
                    break;

                case 'sticker':
                    try {
                        const stickerBuffer = typeof url === 'string' ? await convertToSticker(url) : url; 
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

                    sentMsg = await sock.sendMessage(jid, {
                        text: card.description ? `${card.title}\n\n${card.description}` : card.title,
                        contextInfo: {
                            externalAdReply: {
                                title: card.title,
                                body: card.description || "Clique para abrir",
                                thumbnail: thumbBuffer,
                                sourceUrl: card.link,
                                mediaType: 1, 
                                renderLargerThumbnail: true, 
                                showAdAttribution: true 
                            }
                        }
                    });
                    break;

                case 'pix':
                    // [NATIVO] Implementação de Botão PIX via nativeFlowMessage
                    const pixPayload = {
                        viewOnceMessage: {
                            message: {
                                interactiveMessage: {
                                    header: {
                                        title: caption || "Pagamento PIX",
                                        hasMediaAttachment: false
                                    },
                                    body: {
                                        text: content || "Clique no botão abaixo para copiar a chave PIX."
                                    },
                                    footer: {
                                        text: "Wancora Pay"
                                    },
                                    nativeFlowMessage: {
                                        buttons: [
                                            {
                                                name: "cta_copy",
                                                buttonParamsJson: JSON.stringify({
                                                    display_text: "Copiar Chave PIX",
                                                    id: "pix_copy",
                                                    copy_code: url // A chave PIX vem no campo 'url'
                                                })
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    };
                    
                    const message = generateWAMessageFromContent(jid, pixPayload, { userJid: sock.user.id });
                    await sock.relayMessage(jid, message.message, { messageId: message.key.id });
                    sentMsg = message;
                    break;

                default:
                    sentMsg = await sock.sendMessage(jid, { text: content || "" });
            }

            return sentMsg;

        } catch (err) {
            console.error(`❌ [SENDER] Erro de envio para ${jid}:`, err.message);
            throw err;
        }
    });
};
