
import { sessions } from './connection.js';
import { delay, generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';

// Helper: Delay Aleatório (Humanização)
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// Formata JID
const formatJid = (to) => {
    if (!to) throw new Error("Destinatário inválido");
    if (to.includes('@')) return to; 
    return `${to.replace(/\D/g, '')}@s.whatsapp.net`;
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
    contact
}) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sock) throw new Error(`Sessão ${sessionId} não encontrada.`);

    const sock = session.sock;
    const jid = formatJid(to);

    // Anti-Ban Check
    if (!jid.includes('@g.us')) {
        try {
            const [result] = await sock.onWhatsApp(jid);
            if (result && !result.exists) {
                throw new Error("Número não possui WhatsApp.");
            }
        } catch (e) {
            console.warn(`[ANTI-BAN] Aviso: ${e.message}`);
        }
    }

    try {
        console.log(`🤖 [HUMAN-SEND] Iniciando protocolo para: ${jid} (Tipo: ${type})`);

        await delay(randomDelay(500, 1000));
        const presenceType = (type === 'audio' && ptt) ? 'recording' : 'composing';
        await sock.sendPresenceUpdate(presenceType, jid);

        let typingTime = 1000; 
        if (type === 'text' && content) typingTime = Math.min(content.length * 50, 4000); 
        await delay(typingTime);
        await sock.sendPresenceUpdate('paused', jid);

        let sentMsg;

        switch (type) {
            case 'pix':
                const pixKey = content || "CHAVE_INVALIDA";
                console.log(`💲 [PIX] Gerando payload Native Flow para: ${pixKey}`);

                try {
                    const msgParams = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadata: {},
                                    deviceListMetadataVersion: 2
                                },
                                interactiveMessage: {
                                    body: { text: "Use o botão abaixo para copiar a chave Pix." },
                                    footer: { text: "Pagamento Seguro" },
                                    header: { 
                                        title: "CHAVE PIX", 
                                        subtitle: "Pagamento", 
                                        hasMediaAttachment: false 
                                    },
                                    nativeFlowMessage: {
                                        buttons: [{
                                            name: "cta_copy",
                                            buttonParamsJson: JSON.stringify({
                                                display_text: "COPIAR CHAVE PIX",
                                                id: "copy_code",
                                                copy_code: pixKey
                                            })
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
                    console.error("Erro no Native Flow Pix, enviando fallback:", e);
                    sentMsg = await sock.sendMessage(jid, { 
                        text: `Chave Pix:\n\n${pixKey}` 
                    });
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
                // Tratamento Especial para PTT (Gravador Web)
                // Se for PTT e vier como webm, forçamos audio/ogg; codecs=opus para melhor compatibilidade com WhatsApp Mobile
                let finalMime = mimetype;
                if (ptt && (mimetype === 'audio/webm' || mimetype?.includes('opus'))) {
                    finalMime = 'audio/ogg; codecs=opus';
                }
                
                sentMsg = await sock.sendMessage(jid, { 
                    audio: { url }, 
                    ptt: !!ptt, 
                    mimetype: finalMime || 'audio/mp4' 
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
                sentMsg = await sock.sendMessage(jid, {
                    poll: {
                        name: poll.name,
                        values: poll.options, // Array de strings
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
