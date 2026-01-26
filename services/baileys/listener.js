
import { updateSyncStatus } from '../crm/sync.js';
import { handlePresenceUpdate, handleContactsUpsert } from './handlers/contactHandler.js';
import { handleMessage, handleReceiptUpdate, handleMessageUpdate, handleReaction } from './handlers/messageHandler.js';
import { handleHistorySync } from './handlers/historyHandler.js';

export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    let historyChunkCounter = 0;

    // -----------------------------------------------------------
    // 1. CONEXÃO & GATILHOS
    // -----------------------------------------------------------
    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log(`⚡ [LISTENER] Conexão aberta! Iniciando monitoramento.`);
            // Feedback imediato para o usuário
            await updateSyncStatus(sessionId, 'importing_contacts', 5);
        }
    });

    // -----------------------------------------------------------
    // 2. PRESENÇA & CONTATOS
    // -----------------------------------------------------------
    sock.ev.on('presence.update', (update) => handlePresenceUpdate(update, companyId));
    
    sock.ev.on('contacts.upsert', (contacts) => handleContactsUpsert(contacts, companyId));
    
    sock.ev.on('contacts.update', async (updates) => {
        // Updates parciais (ex: foto nova)
        for (const update of updates) {
            if (update.imgUrl) {
                // Reutiliza função do handler, passando array de 1
                handleContactsUpsert([update], companyId);
            }
        }
    });

    // -----------------------------------------------------------
    // 3. MENSAGENS (CORE)
    // -----------------------------------------------------------
    
    // Novas Mensagens (Upsert)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // type: 'notify' (Realtime) | 'append' (Histórico/Outro device)
        const isRealtime = type === 'notify';
        
        for (const msg of messages) {
            await handleMessage(msg, sock, companyId, sessionId, isRealtime);
        }
    });

    // Atualizações (Polls, Edições)
    sock.ev.on('messages.update', (updates) => handleMessageUpdate(updates, companyId));

    // Status de Leitura (Ticks)
    sock.ev.on('message-receipt.update', (events) => handleReceiptUpdate(events, companyId));

    // Reações (Emojis)
    sock.ev.on('messages.reaction', (reactions) => handleReaction(reactions, sock, companyId));

    // -----------------------------------------------------------
    // 4. HISTÓRICO (SYNC)
    // -----------------------------------------------------------
    sock.ev.on('messaging-history.set', (data) => {
        historyChunkCounter++;
        handleHistorySync(data, sock, sessionId, companyId, historyChunkCounter);
    });
};
