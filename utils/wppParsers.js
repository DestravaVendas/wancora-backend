
// Helpers para tratamento de dados do WhatsApp e Proto Parsing

export const normalizeJid = (jid) => {
    if (!jid) return null;
    
    // Se for broadcast de status
    if (jid === 'status@broadcast') return jid;
    
    // Separa o JID de sufixos de dispositivo (Ex: :12)
    const [user, domain] = jid.split('@');
    
    // Se não tiver @, retorna como está (invalido, mas evita crash)
    if (!domain) return jid;
    
    // Limpa a parte do usuário (remove :12 no final se houver antes do @, embora raro no formato novo)
    // E limpa a parte do domínio se houver :
    
    // Formato padrão Baileys: 55119999@s.whatsapp.net:12
    // Deve virar: 55119999@s.whatsapp.net
    
    // Se já contém o domínio correto
    if (jid.includes('@g.us')) {
        return jid.split('@')[0] + '@g.us';
    }
    
    if (jid.includes('@s.whatsapp.net')) {
        return jid.split('@')[0].split(':')[0] + '@s.whatsapp.net';
    }
    
    if (jid.includes('@lid')) {
         return jid.split('@')[0].split(':')[0] + '@lid';
    }

    return jid; // Fallback
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

    // Produtos (NOVO)
    if (msg.productMessage) {
        return `Produto: ${msg.productMessage.product?.title || 'Ver produto'}`;
    }

    // Sticker
    if (msg.stickerMessage) return "Figurinha";

    if (msg.protocolMessage) return ''; // Ignora mensagens de protocolo (ex: delete)
    
    return ''; 
};

export const getContentType = (message) => {
    if (!message) return null;
    const keys = Object.keys(message);
    const key = keys.find(k => k === 'conversation' || k.endsWith('Message'));
    return key;
};
