import { updateSyncStatus } from '../crm/sync.js';
import { handlePresenceUpdate, handleContactsUpsert } from './handlers/contactHandler.js';
import { handleReceiptUpdate, handleMessageUpdate, handleReaction } from './handlers/messageHandler.js';
import { handleHistorySync, resetHistoryState } from './handlers/historyHandler.js'; // Import atualizado
import { enqueueMessage } from './messageQueue.js'; 

export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // [CRÍTICO] Reset de Estado de Histórico
    // Garante que uma reconexão não use cache de chunks processados anteriormente
    resetHistoryState(sessionId);
    
    let historyChunkCounter = 0;

    // 1. CONEXÃO
    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log(`⚡ [LISTENER] Conexão aberta!`);
            await updateSyncStatus(sessionId, 'importing_contacts', 5);
        }
    });

    // 2. PRESENÇA & CONTATOS
    sock.ev.on('presence.update', (update) => handlePresenceUpdate(update, companyId));
    
    sock.ev.on('contacts.upsert', async (contacts) => {
        // 1. Mantém a rotina original de salvar contatos
        handleContactsUpsert(contacts, companyId);
        
        // 2. 🛡️ [MAPA DE IDENTIDADE] O WhatsApp entrega a relação LID <-> Phone aqui
        try {
            const { createClient } = await import('@supabase/supabase-js');
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

            for (const contact of contacts) {
                // Se o contato veio com o número de telefone E o código LID
                if (contact.id && contact.lid) {
                    const cleanPhone = contact.id.replace(/:[0-9]+@/, '@'); // Remove porta de dispositivo
                    const cleanLid = contact.lid.replace(/:[0-9]+@/, '@');

                    // Executa a RPC silenciosamente para mapear no banco
                    supabase.rpc('link_identities', { 
                        p_lid: cleanLid, 
                        p_phone: cleanPhone, 
                        p_company_id: companyId 
                    }).catch(() => {});
                }
            }
        } catch (e) {
            console.error("❌ [LISTENER] Erro no mapeamento de LID:", e.message);
        }
    });
    
    sock.ev.on('contacts.update', async (updates) => {
        for (const update of updates) {
            if (update.imgUrl || update.notify) {
                handleContactsUpsert([update], companyId);
            }
        }
    });

    // 3. MENSAGENS (FILA)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const isRealtime = type === 'notify';
        for (const msg of messages) {
            enqueueMessage(msg, sock, companyId, sessionId, isRealtime);
        }
    });

    sock.ev.on('messages.update', (updates) => handleMessageUpdate(updates, companyId));
    sock.ev.on('message-receipt.update', (events) => handleReceiptUpdate(events, companyId));
    sock.ev.on('messages.reaction', (reactions) => handleReaction(reactions, sock, companyId));

    // 4. HISTÓRICO (SYNC)
    sock.ev.on('messaging-history.set', (data) => {
        historyChunkCounter++;
        handleHistorySync(data, sock, sessionId, companyId, historyChunkCounter);
    });
};
