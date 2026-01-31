
import { sessions } from './connection.js';
import { normalizeJid } from '../crm/sync.js';

// JID padrão para envio de status
const STATUS_BROADCAST_JID = 'status@broadcast';

export const sendStatusText = async (sessionId, text, backgroundColor = '#000000', font = 1) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    // ARGB Hex para Inteiro
    const bgArgb = parseInt(backgroundColor.replace('#', 'FF'), 16);

    const result = await session.sock.sendMessage(STATUS_BROADCAST_JID, {
        text: text,
        backgroundArgb: bgArgb,
        font: font // 1: SERIF, 2: NORICAN, 3: BRYNDAN_WRITE, 4: OSWALD
    });

    return result;
};

export const sendStatusMedia = async (sessionId, mediaUrl, type, caption) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    const payload = {};
    if (type === 'image') payload.image = { url: mediaUrl };
    else if (type === 'video') payload.video = { url: mediaUrl };
    else throw new Error("Tipo de mídia inválido para status.");

    if (caption) payload.caption = caption;

    const result = await session.sock.sendMessage(STATUS_BROADCAST_JID, payload);
    return result;
};

// Obter lista de Status dos contatos (Requer escutar eventos messages.upsert no handler)
// Aqui apenas fornecemos métodos ativos, não listeners.
