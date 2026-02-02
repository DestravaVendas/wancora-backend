
import { updateSyncStatus } from '../crm/sync.js';
import { handlePresenceUpdate, handleContactsUpsert } from './handlers/contactHandler.js';
import { handleReceiptUpdate, handleMessageUpdate, handleReaction } from './handlers/messageHandler.js';
import { handleHistorySync } from './handlers/historyHandler.js';
import { enqueueMessage } from './messageQueue.js'; 

export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // -----------------------------------------------------------
    // 1. CONEXÃO & GATILHOS
    // -----------------------------------------------------------
    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log(`⚡ [LISTENER] Conexão aberta! Iniciando monitoramento.`);
            // Inicia o estado no banco
            await updateSyncStatus(sessionId, 'importing_contacts', 1);
        }
    });

    // -----------------------------------------------------------
    // 2. PRESENÇA & CONTATOS
    // -----------------------------------------------------------
    sock.ev.on('presence.update', (update) => handlePresenceUpdate(update, companyId));
    
    sock.ev.on('contacts.upsert', (contacts) => handleContactsUpsert(contacts, companyId));
    
    sock.ev.on('contacts.update', async (updates) => {
        for (const update of updates) {
            if (update.imgUrl) {
                handleContactsUpsert([update], companyId);
            }
        }
    });

    // -----------------------------------------------------------
    // 3. MENSAGENS (CORE)
    // -----------------------------------------------------------
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const isRealtime = type === 'notify';
        for (const msg of messages) {
            enqueueMessage(msg, sock, companyId, sessionId, isRealtime);
        }
    });

    sock.ev.on('messages.update', (updates) => handleMessageUpdate(updates, companyId));
    sock.ev.on('message-receipt.update', (events) => handleReceiptUpdate(events, companyId));
    sock.ev.on('messages.reaction', (reactions) => handleReaction(reactions, sock, companyId));

    // -----------------------------------------------------------
    // 4. HISTÓRICO (SYNC UNIFICADO)
    // -----------------------------------------------------------
    sock.ev.on('messaging-history.set', (data) => {
        // Envia o pacote para o handler. O handler vai acumular no buffer.
        handleHistorySync(data, sock, sessionId, companyId);
    });
};
