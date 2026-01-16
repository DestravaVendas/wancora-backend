
/**
 * Wancora CRM - WhatsApp Parsers
 * Utilitários para limpar e extrair dados dos objetos brutos do Baileys.
 * Mantém a lógica de "unwrap" para ViewOnce, Ephemeral e Edições.
 */

// --- Desenrola mensagens complexas (ViewOnce, Editadas, Temporárias) ---
export const unwrapMessage = (msg) => {
    if (!msg.message) return msg;
    
    let content = msg.message;
    
    // Desenrola Ephemeral (Mensagens temporárias)
    if (content.ephemeralMessage) {
        content = content.ephemeralMessage.message;
    }
    // Desenrola ViewOnce (Visualização única V1)
    if (content.viewOnceMessage) {
        content = content.viewOnceMessage.message;
    }
    // Desenrola ViewOnceV2 (Visualização única V2 - comum em áudios/vídeos novos)
    if (content.viewOnceMessageV2) {
        content = content.viewOnceMessageV2.message;
    }
    // Desenrola Documentos com Legenda
    if (content.documentWithCaptionMessage) {
        content = content.documentWithCaptionMessage.message;
    }
    // Desenrola Mensagens Editadas
    if (content.editedMessage) {
        content = content.editedMessage.message.protocolMessage.editedMessage;
    }

    return { ...msg, message: content };
};

// --- Extrai o texto visível de qualquer tipo de mensagem ---
export const getMessageContent = (msg) => {
    if (!msg) return "";
    
    // Texto Simples & Estendido
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    
    // Legendas de Mídia (Prioridade para captions)
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;
    
    // Botões (Legacy & New)
    if (msg.templateButtonReplyMessage?.selectedId) return msg.templateButtonReplyMessage.selectedId;
    if (msg.buttonsResponseMessage?.selectedButtonId) return msg.buttonsResponseMessage.selectedButtonId;
    if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) return msg.listResponseMessage.singleSelectReply.selectedRowId;
    
    // Enquetes (Fallback para texto simples se não for tratado especificamente depois)
    if (msg.pollCreationMessageV3?.name) return msg.pollCreationMessageV3.name;
    if (msg.pollCreationMessage?.name) return msg.pollCreationMessage.name;

    return "";
};

// --- Determina o tipo da mensagem para salvar no Banco (Enum do Postgres) ---
export const getMessageType = (msg) => {
    if (!msg) return 'text';

    if (msg.imageMessage) return 'image';
    if (msg.audioMessage) return 'audio'; 
    if (msg.videoMessage) return 'video';
    if (msg.documentMessage) return 'document';
    if (msg.stickerMessage) return 'sticker';
    if (msg.pollCreationMessage || msg.pollCreationMessageV3) return 'poll';
    if (msg.locationMessage) return 'location';
    if (msg.contactMessage || msg.contactsArrayMessage) return 'contact';
    
    // Live Location (Tratada como location)
    if (msg.liveLocationMessage) return 'location';

    return 'text';
};

// --- NOVO: Extrai Votos de Enquete (Poll Update) ---
export const parsePollUpdate = (update) => {
    try {
        const { vote } = update;
        if (!vote) return null;
        
        const voterJid = update.key.participant || update.key.remoteJid;
        
        // Baileys retorna os hashes das opções selecionadas.
        const selectedOptions = vote.selectedOptions || [];
        
        return {
            pollId: update.key.id,
            voterJid: voterJid,
            selectedHashes: selectedOptions.map(opt => opt.toString('hex'))
        };
    } catch (e) {
        console.error("Erro parsePollUpdate:", e);
        return null;
    }
};
