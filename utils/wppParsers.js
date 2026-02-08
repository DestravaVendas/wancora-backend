
// Helpers para tratamento de dados do WhatsApp e Proto Parsing

export const normalizeJid = (jid) => {
    if (!jid) return null;
    
    // Se for broadcast de status
    if (jid === 'status@broadcast') return jid;
    
    // Separa o JID de sufixos de dispositivo (Ex: :12)
    // Formato padrão Baileys: 55119999@s.whatsapp.net:12
    const parts = jid.split(':');
    const userDomain = parts[0]; // Pega tudo antes do :
    
    // Se já contém o domínio correto
    if (userDomain.includes('@g.us')) {
        return userDomain.split('@')[0] + '@g.us';
    }
    
    if (userDomain.includes('@s.whatsapp.net')) {
        return userDomain.split('@')[0] + '@s.whatsapp.net';
    }
    
    if (userDomain.includes('@lid')) {
         return userDomain.split('@')[0] + '@lid';
    }
    
    if (userDomain.includes('@newsletter')) {
        return userDomain;
    }

    // FIX CRÍTICO: Se não tem @ e parece um número, adiciona o domínio padrão
    // Isso impede o erro "jidDecode undefined" no Baileys
    if (!jid.includes('@')) {
        const cleanNumber = jid.replace(/\D/g, '');
        // Validação mínima de comprimento (DDI + DDD + Num > 8 digitos)
        if (cleanNumber.length > 5) { 
            return `${cleanNumber}@s.whatsapp.net`;
        }
    }

    return jid; // Fallback se não bater padrões
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
    if (!msg) return null; // Retorna null em vez de string vazia para facilitar filtragem
    
    // Texto Puro
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    
    // Legendas de Mídia
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;
    
    // Enquetes (Criação)
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

    // --- TIPOS TÉCNICOS QUE NÃO DEVEM VIRAR MENSAGEM ---
    if (msg.protocolMessage) return null; // Delete, History Sync, etc
    if (msg.reactionMessage) return null; // Reação não é texto
    if (msg.pollUpdateMessage) return null; // Voto não é texto
    if (msg.keepInChatMessage) return null; 
    if (msg.pinInChatMessage) return null;

    return null; 
};

export const getContentType = (message) => {
    if (!message) return null;
    const keys = Object.keys(message);
    // Ignora chaves de metadados
    const key = keys.find(k => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage' && (k === 'conversation' || k.endsWith('Message')));
    return key;
};
