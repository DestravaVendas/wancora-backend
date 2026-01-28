
// Helpers para tratamento de dados do WhatsApp e Proto Parsing

export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid;
    if (jid.includes('@newsletter')) return jid;
    return jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
};

// Desenrola mensagens complexas (ViewOnce, Ephemeral, Edited, DocumentWithCaption)
export const unwrapMessage = (msg) => {
    if (!msg.message) return msg;
    let content = msg.message;
    
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    if (content.viewOnceMessage) content = content.viewOnceMessage.message;
    if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
    
    // Suporte a Documento com Legenda (Aninhamento específico do Baileys/WA)
    if (content.documentWithCaptionMessage) {
        content = content.documentWithCaptionMessage.message;
    }
    
    if (content.editedMessage) {
        content = content.editedMessage.message?.protocolMessage?.editedMessage || content.editedMessage.message;
    }
    
    return { ...msg, message: content };
};

// Extrai o texto legível de qualquer tipo de mensagem
export const getBody = (msg) => {
    if (!msg) return '';
    
    // Texto Puro
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    
    // Legendas de Mídia
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;
    
    // Enquetes
    if (msg.pollCreationMessageV3) return msg.pollCreationMessageV3.name;
    if (msg.pollCreationMessage) return msg.pollCreationMessage.name;
    
    // Locations
    if (msg.locationMessage) return "Loc: " + (msg.locationMessage.degreesLatitude + ", " + msg.locationMessage.degreesLongitude);
    if (msg.liveLocationMessage) return "Loc: " + (msg.liveLocationMessage.degreesLatitude + ", " + msg.liveLocationMessage.degreesLongitude);

    // Contatos
    if (msg.contactMessage) return msg.contactMessage.displayName;

    if (msg.protocolMessage) return ''; // Ignora mensagens de protocolo (ex: delete)
    
    return ''; 
};

export const getContentType = (message) => {
    if (!message) return null;
    const keys = Object.keys(message);
    const key = keys.find(k => k === 'conversation' || k.endsWith('Message'));
    return key;
};
