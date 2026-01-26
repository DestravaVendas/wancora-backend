import { sessions } from './connection.js';
import { delay, generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';

// Helper: Delay Aleatório (Humanização)
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// Formata JID para garantir que @s.whatsapp.net esteja correto
const formatJid = (to) => {
    if (!to) throw new Error("Destinatário inválido");
    if (to.includes('@')) return to; // Já formatado ou Grupo
    return `${to.replace(/\D/g, '')}@s.whatsapp.net`;
};

/**
 * Envia mensagem via Baileys com Protocolo de Humanização
 * Centraliza toda lógica de disparo para API e Workers
 */
export const sendMessage = async ({
    sessionId,
    to,
    type = 'text',
    content,   // Texto principal (ou chave pix, ou json location)
    url,       // URL da mídia (Storage)
    caption,   // Legenda da mídia
    fileName,  // Nome do arquivo para docs
    mimetype,  // MimeType forçado
    ptt = false, // Se true, envia como "nota de voz" (onda verde)
    poll,      // Objeto de enquete { name, options, count }
    location,  // Objeto de localização { lat, lng }
    contact    // Objeto de contato { vcard }
}) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sock) throw new Error(`Sessão ${sessionId} não encontrada ou desconectada.`);

    const sock = session.sock;
    const jid = formatJid(to);

    // 1. Checagem de Segurança (Anti-Ban)
    // Verifica se o número existe no WhatsApp antes de tentar enviar (exceto grupos)
    if (!jid.includes('@g.us')) {
        try {
            const [result] = await sock.onWhatsApp(jid);
            if (result && !result.exists) {
                console.warn(`⚠️ [ANTI-BAN] Número ${jid} não verificado no WhatsApp. Abortando envio.`);
                throw new Error("Número não possui WhatsApp.");
            }
        } catch (e) {
            // Se der erro na checagem, loga mas tenta enviar (fail-open)
            console.warn(`[ANTI-BAN] Falha ao verificar existência do número: ${e.message}`);
        }
    }

    try {
        console.log(`🤖 [HUMAN-SEND] Iniciando protocolo para: ${jid} (Tipo: ${type})`);

        // 2. Delay Inicial e Simulação de Presença
        await delay(randomDelay(300, 800));
        
        const presenceType = (type === 'audio' && ptt) ? 'recording' : 'composing';
        await sock.sendPresenceUpdate(presenceType, jid);

        // 3. Tempo de Produção (Simula tempo para escrever/gravar)
        let typingTime = 1500; 
        if (type === 'text' && content) {
            typingTime = Math.min(content.length * 50, 5000); 
        }
        await delay(typingTime);
        
        await sock.sendPresenceUpdate('paused', jid);

        let sentMsg;

        // 4. Switch de Tipos de Mensagem
        switch (type) {
            case 'pix':
                // --- PIX NATIVE FLOW (BOTÃO DE CÓPIA) ---
                const pixKey = content || "CHAVE_NAO_INFORMADA";
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
                                    body: { text: "Copie a chave abaixo para realizar o pagamento." },
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
                    // Relay Message é necessário para payloads complexos
                    const waMessage = await generateWAMessageFromContent(jid, msgParams, { userJid: sock.user.id });
                    await sock.relayMessage(jid, waMessage.message, { messageId: waMessage.key.id });
                    sentMsg = waMessage;
                } catch (e) {
                    console.error("Erro ao enviar botão Pix (Fallback para texto):", e);
                    sentMsg = await sock.sendMessage(jid, { 
                        text: `Chave Pix:\n\n${pixKey}\n\n_(Caso o botão acima não funcione)_` 
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
                // ptt: true envia como nota de voz (onda verde)
                sentMsg = await sock.sendMessage(jid, { 
                    audio: { url }, 
                    ptt: !!ptt, 
                    mimetype: mimetype || 'audio/mp4' 
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
                // Fallback seguro
                sentMsg = await sock.sendMessage(jid, { text: content || "" });
        }

        return sentMsg;

    } catch (err) {
        console.error(`❌ [SENDER] Erro no envio seguro para ${jid}:`, err.message);
        throw err;
    }
};
