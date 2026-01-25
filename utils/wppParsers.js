// Helpers para tratamento de dados do WhatsApp

export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid;
    return jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
};

export const getContentType = (message) => {
    if (!message) return null;
    const keys = Object.keys(message);
    const key = keys.find(k => k === 'conversation' || k.endsWith('Message'));
    return key;
};

export const extractBody = (msg) => {
    if (!msg) return '';
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    return '';
};