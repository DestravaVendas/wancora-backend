
import { sessions } from './connection.js';
import { delay } from '@whiskeysockets/baileys';

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

    // 1. Checagem de Segurança: O número existe? (Ignora grupos)
    if (!jid.includes('@g.us')) {
        // Nota: onWhatsApp pode falhar em alguns casos de instabilidade do Meta, 
        // então usamos um try/catch frouxo apenas para logar, mas não bloqueamos o envio 
        // para não prejudicar a UX em caso de falso negativo.
        try {
            const [result] = await sock.onWhatsApp(jid);
            if (result && !result.exists) {
                console.warn(`⚠️ [ANTI-BAN] Número ${jid} não verificado no WhatsApp.`);
            }
        } catch (e) {}
    }

    try {
        console.log(`🤖 [HUMAN-SEND] Iniciando protocolo para: ${jid}`);

        // 2. Delay Inicial (Simula tempo de reação)
        await delay(randomDelay(500, 1500));

        // 3. Simula "Digitando..." ou "Gravando..."
        const presenceType = (type === 'audio' && ptt) ? 'recording' : 'composing';
        await sock.sendPresenceUpdate(presenceType, jid);

        // 4. Delay de Produção (Baseado no tamanho do conteúdo)
        let typingTime = 2000; // Mínimo 2s
        if (type === 'text' && content) {
            const textLen = content.length;
            // ~100ms por caractere, teto de 10s
            typingTime = Math.min(textLen * 100, 10000); 
        } else if (type === 'audio') {
            // Simula tempo de gravação
            typingTime = randomDelay(3000, 6000); 
        }

        await delay(typingTime);

        // 5. Pausa (Momento antes de enviar)
        await sock.sendPresenceUpdate('paused', jid);

        // 6. Montagem do Payload
        let payload = {};

        switch (type) {
            case 'text':
                payload = { text: content || "" };
                break;
            
            case 'pix':
                // IMPLEMENTAÇÃO DO BOTÃO "COPIAR" NATIVO
                // Usa 'interactiveMessage' com 'native_flow_message' -> 'cta_copy'
                payload = {
                    viewOnceMessage: {
                        message: {
                            interactiveMessage: {
                                header: {
                                    title: "PAGAMENTO VIA PIX",
                                    subtitle: "Pagamento Instantâneo",
                                    hasMediaAttachment: false
                                },
                                body: {
                                    text: "Copie a chave abaixo e cole no seu aplicativo bancário para finalizar o pagamento."
                                },
                                footer: {
                                    text: "Wancora Secure Pay"
                                },
                                nativeFlowMessage: {
                                    buttons: [
                                        {
                                            name: "cta_copy",
                                            buttonParamsJson: JSON.stringify({
                                                display_text: "COPIAR CHAVE PIX",
                                                id: "copy_pix_key",
                                                copy_code: content // A chave Pix vem aqui
                                            })
                                        }
                                    ]
                                }
                            }
                        }
                    }
                };
                break;

            case 'image':
                payload = { image: { url }, caption: caption };
                break;

            case 'video':
                payload = { video: { url }, caption: caption, gifPlayback: false };
                break;

            case 'audio':
                payload = { audio: { url }, ptt: !!ptt, mimetype: mimetype || 'audio/mp4' };
                break;

            case 'document':
                payload = { document: { url }, mimetype: mimetype || 'application/pdf', fileName: fileName || 'documento' };
                if (caption) payload.caption = caption;
                break;

            case 'poll':
                if (!poll || !poll.name || !poll.options) throw new Error("Dados da enquete inválidos");
                payload = {
                    poll: {
                        name: poll.name,
                        values: poll.options,
                        selectableCount: poll.selectableOptionsCount || 1
                    }
                };
                break;

            case 'location':
                if (!location || !location.latitude || !location.longitude) throw new Error("Dados de localização inválidos");
                payload = {
                    location: {
                        degreesLatitude: location.latitude,
                        degreesLongitude: location.longitude
                    }
                };
                break;

            case 'contact':
                if (!contact || !contact.vcard) throw new Error("Dados de contato inválidos");
                payload = {
                    contacts: {
                        displayName: contact.displayName,
                        contacts: [{ vcard: contact.vcard }]
                    }
                };
                break;

            default:
                payload = { text: content || "" };
        }

        // 7. Disparo Real
        const sentMsg = await sock.sendMessage(jid, payload);
        return sentMsg;

    } catch (err) {
        console.error("❌ Erro no envio seguro:", err);
        // Garante que para de digitar se der erro
        if (session && session.sock) {
            await sock.sendPresenceUpdate('paused', jid).catch(() => {});
        }
        throw err;
    }
};
