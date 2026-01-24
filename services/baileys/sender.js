
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

    // 1. Checagem de Segurança: O número existe? (Ignora grupos)
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

        // 2. Delay Inicial (Simula tempo de reação)
        await delay(randomDelay(500, 1500));

        // 3. Simula "Digitando..." ou "Gravando..."
        const presenceType = (type === 'audio' && ptt) ? 'recording' : 'composing';
        await sock.sendPresenceUpdate(presenceType, jid);

        // 4. Delay de Produção (Baseado no tamanho do conteúdo)
        let typingTime = 2000; // Mínimo 2s
        if (type === 'text' && content) {
            const textLen = content.length;
            typingTime = Math.min(textLen * 100, 10000); 
        } else if (type === 'audio') {
            typingTime = randomDelay(3000, 6000); 
        }

        await delay(typingTime);

        // 5. Pausa (Momento antes de enviar)
        await sock.sendPresenceUpdate('paused', jid);

        // 6. Montagem do Payload e Envio
        let sentMsg;

        switch (type) {
            case 'pix':
                // FIX CRÍTICO PIX V2: Estrutura Interactive Message Native Flow
                const pixKey = content || "CHAVE_NAO_INFORMADA";
                console.log(`💲 [PIX] Gerando payload Native Flow para: ${pixKey}`);

                // Estrutura Proto Exata para Botão de Cópia
                const buttonParams = JSON.stringify({
                    display_text: "COPIAR CHAVE PIX",
                    id: "copy_code",
                    copy_code: pixKey
                });

                const interactiveMessage = {
                    body: { text: "Copie a chave abaixo para realizar o pagamento." },
                    footer: { text: "Wancora Secure Pay" },
                    header: { title: "PAGAMENTO VIA PIX", subtitle: "Instantâneo", hasMediaAttachment: false },
                    nativeFlowMessage: {
                        buttons: [{
                            name: "cta_copy",
                            buttonParamsJson: buttonParams
                        }]
                    }
                };

                const messagePayload = {
                    viewOnceMessage: {
                        message: {
                            interactiveMessage: interactiveMessage
                        }
                    }
                };

                // Gera a mensagem raw usando o userJid da sessão conectada
                const waMessage = await generateWAMessageFromContent(jid, messagePayload, { 
                    userJid: sock.user.id 
                });
                
                // Envia via Relay com tratamento de erro específico
                try {
                    await sock.relayMessage(jid, waMessage.message, { messageId: waMessage.key.id });
                    sentMsg = waMessage;
                    console.log(`✅ [PIX] Enviado com sucesso via Relay. ID: ${waMessage.key.id}`);
                } catch (relayError) {
                    console.error(`❌ [PIX] Erro no relayMessage:`, relayError);
                    throw new Error(`Falha no envio do Card Pix: ${relayError.message}`);
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
                sentMsg = await sock.sendMessage(jid, { audio: { url }, ptt: !!ptt, mimetype: mimetype || 'audio/mp4' });
                break;

            case 'document':
                sentMsg = await sock.sendMessage(jid, { document: { url }, mimetype: mimetype || 'application/pdf', fileName: fileName || 'documento', caption: caption });
                break;

            case 'poll':
                if (!poll || !poll.name || !poll.options) throw new Error("Dados da enquete inválidos");
                console.log(`📊 [POLL] Criando Enquete: ${poll.name}`);
                
                sentMsg = await sock.sendMessage(jid, {
                    poll: {
                        name: poll.name,
                        values: poll.options, // Array de strings simples
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
        if (session && session.sock) {
            await sock.sendPresenceUpdate('paused', jid).catch(() => {});
        }
        throw err;
    }
};
