
import { sessions } from './connection.js';
import { delay, generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';

// Helper: Delay Aleatório
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// Formata JID
const formatJid = (to) => {
    if (!to) throw new Error("Destinatário inválido");
    if (to.includes('@')) return to;
    return `${to.replace(/\D/g, '')}@s.whatsapp.net`;
};

/**
 * Envia mensagem via Baileys com Protocolo de Humanização
 */
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
    if (!session || !session.sock) throw new Error(`Sessão ${sessionId} não encontrada ou desconectada.`);

    const sock = session.sock;
    const jid = formatJid(to);

    // 1. Checagem de Segurança
    if (!jid.includes('@g.us')) {
        try {
            const [result] = await sock.onWhatsApp(jid);
            if (result && !result.exists) {
                console.warn(`⚠️ [ANTI-BAN] Número ${jid} não verificado no WhatsApp.`);
            }
        } catch (e) {}
    }

    try {
        console.log(`🤖 [HUMAN-SEND] Iniciando protocolo para: ${jid} (Tipo: ${type})`);

        // 2. Delay e Presença
        await delay(randomDelay(300, 800));
        const presenceType = (type === 'audio' && ptt) ? 'recording' : 'composing';
        await sock.sendPresenceUpdate(presenceType, jid);

        let typingTime = 1500; 
        if (type === 'text' && content) {
            typingTime = Math.min(content.length * 50, 5000); 
        }
        await delay(typingTime);
        await sock.sendPresenceUpdate('paused', jid);

        let sentMsg;

        switch (type) {
            case 'pix':
                // CORREÇÃO CRÍTICA PIX: Usar viewOnceMessage com interactiveMessage (Native Flow)
                // A estrutura precisa estar EXATAMENTE como abaixo para funcionar em Android/iOS
                const pixKey = content || "CHAVE_NAO_INFORMADA";
                console.log(`💲 [PIX] Gerando payload Native Flow para: ${pixKey}`);

                const msgParams = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadata: {},
                                deviceListMetadataVersion: 2
                            },
                            interactiveMessage: {
                                body: { text: "Copie a chave abaixo para realizar o pagamento." },
                                footer: { text: "Wancora Secure Pay" },
                                header: { 
                                    title: "PAGAMENTO VIA PIX", 
                                    subtitle: "Instantâneo", 
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

                const waMessage = await generateWAMessageFromContent(jid, msgParams, { 
                    userJid: sock.user.id 
                });
                
                await sock.relayMessage(jid, waMessage.message, { messageId: waMessage.key.id });
                sentMsg = waMessage;
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
                sentMsg = await sock.sendMessage(jid, { audio: { url }, ptt: !!ptt, mimetype: mimetype || 'audio/mp4' });
                break;

            case 'document':
                sentMsg = await sock.sendMessage(jid, { document: { url }, mimetype: mimetype || 'application/pdf', fileName: fileName || 'documento', caption: caption });
                break;

            case 'poll':
                if (!poll || !poll.name || !poll.options) throw new Error("Dados da enquete inválidos");
                sentMsg = await sock.sendMessage(jid, {
                    poll: {
                        name: poll.name,
                        values: poll.options,
                        selectableCount: Number(poll.selectableOptionsCount) || 1
                    }
                });
                break;

            case 'location':
                if (!location || !location.latitude || !location.longitude) throw new Error("Dados de localização inválidos");
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
        console.error("❌ Erro no envio seguro:", err);
        throw err;
    }
};
