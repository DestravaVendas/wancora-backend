
import { sessions } from './connection.js';
import { delay, generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import { normalizeJid } from '../../utils/wppParsers.js';

// Helper: Delay Aleatório (Humanização)
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

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
    contact
}) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sock) throw new Error(`Sessão ${sessionId} não encontrada.`);

    const sock = session.sock;
    const jid = normalizeJid(to);

    try {
        console.log(`🤖 [HUMAN-SEND] Iniciando protocolo para: ${jid} (Tipo: ${type})`);

        // 1. Pausa Inicial
        await delay(randomDelay(500, 1000));
        
        // 2. Simulação de Presença
        const presenceType = (type === 'audio' && ptt) ? 'recording' : 'composing';
        await sock.sendPresenceUpdate(presenceType, jid);

        // 3. Cálculo de Tempo de Produção (Inteligente)
        let productionTime = 1000; 
        if (type === 'text' && content) {
            productionTime = Math.min(content.length * 50, 5000); 
        } else if (type === 'audio' || ptt) {
            productionTime = randomDelay(3000, 6000);
        }

        await delay(productionTime);
        await sock.sendPresenceUpdate('paused', jid);

        let sentMsg;

        switch (type) {
            case 'pix':
                // ... (Pix mantido igual)
                const pixKey = content || "CHAVE_INVALIDA";
                try {
                    const msgParams = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                                interactiveMessage: {
                                    header: { title: "CHAVE PIX", subtitle: "Pagamento", hasMediaAttachment: false },
                                    body: { text: "Copie a chave abaixo para finalizar seu pedido." },
                                    footer: { text: "Pagamento Seguro" },
                                    nativeFlowMessage: {
                                        buttons: [{
                                            name: "cta_copy",
                                            buttonParamsJson: JSON.stringify({ display_text: "COPIAR CHAVE PIX", id: "copy_code", copy_code: pixKey })
                                        }]
                                    }
                                }
                            }
                        }
                    };
                    const waMessage = await generateWAMessageFromContent(jid, msgParams, { userJid: sock.user.id });
                    await sock.relayMessage(jid, waMessage.message, { messageId: waMessage.key.id });
                    sentMsg = waMessage;
                } catch (e) {
                    sentMsg = await sock.sendMessage(jid, { text: `Chave Pix:\n\n${pixKey}` });
                }
                break;

            case 'text':
                sentMsg = await sock.sendMessage(jid, { text: content || "" });
                break;

            case 'image':
                sentMsg = await sock.sendMessage(jid, { image: { url }, caption: caption });
                break;

            case 'video':
                sentMsg = await sock.sendMessage(jid, { video: { url }, caption: caption, gifPlayback: false });
                break;

            case 'audio':
                // AUDIO FIX: Respeita o mimetype original se possível.
                // WhatsApp aceita MP4/AAC e OGG/Opus para PTT.
                // Se o frontend mandou mp4, enviamos como mp4.
                // Apenas se for 'ptt: true', o WhatsApp trata como voice note (onda verde).
                
                let finalMime = mimetype;
                // Se não veio mimetype, assume mp4 (mais seguro que ogg)
                if (!finalMime) finalMime = 'audio/mp4';
                
                sentMsg = await sock.sendMessage(jid, { 
                    audio: { url }, 
                    ptt: !!ptt, 
                    mimetype: finalMime 
                });
                break;

            case 'document':
                sentMsg = await sock.sendMessage(jid, { 
                    document: { url }, 
                    mimetype: mimetype || 'application/pdf', 
                    fileName: fileName || 'documento', 
                    caption: caption 
                });
                break;

            case 'sticker':
                sentMsg = await sock.sendMessage(jid, { sticker: { url } });
                break;

            case 'poll':
                if (!poll || !poll.name || !poll.options) throw new Error("Dados da enquete inválidos");
                const cleanOptions = poll.options.map(opt => opt.trim()).filter(opt => opt.length > 0);
                if (cleanOptions.length < 2) throw new Error("Enquete precisa de pelo menos 2 opções válidas.");

                sentMsg = await sock.sendMessage(jid, {
                    poll: {
                        name: poll.name.trim(),
                        values: cleanOptions, 
                        selectableCount: Number(poll.selectableOptionsCount) || 1
                    }
                });
                break;

            case 'location':
                if (!location) throw new Error("Dados de localização inválidos");
                sentMsg = await sock.sendMessage(jid, {
                    location: {
                        degreesLatitude: location.latitude,
                        degreesLongitude: location.longitude
                    }
                });
                break;

            case 'contact':
                if (!contact || !contact.vcard) throw new Error("Dados de contato inválidos");
                sentMsg = await sock.sendMessage(jid, {
                    contacts: {
                        displayName: contact.displayName,
                        contacts: [{ vcard: contact.vcard }]
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
