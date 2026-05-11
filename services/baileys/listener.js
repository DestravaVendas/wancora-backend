import { updateSyncStatus } from '../crm/sync.js';
import { handlePresenceUpdate, handleContactsUpsert } from './handlers/contactHandler.js';
import { handleReceiptUpdate, handleMessageUpdate, handleReaction } from './handlers/messageHandler.js';
import { handleHistorySync, resetHistoryState } from './handlers/historyHandler.js'; // Import atualizado
import { handleGroupsUpsert } from './handlers/groupHandler.js'; // [NOVO] Handler de Comunidades
import { enqueueMessage, drainSessionQueue } from './messageQueue.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // [CRÍTICO] Reset de Estado de Histórico
    // Garante que uma reconexão não use cache de chunks processados anteriormente
    resetHistoryState(sessionId);
    
    let historyChunkCounter = 0;

    // ==========================================================================
    // SERIALIZAÇÃO DE CHUNKS: Fila de Promises para garantir que apenas 1 chunk
    // seja processado por vez. Sem isso, chunks concorrentes podem gerar race
    // conditions onde a Fase 3 de um chunk começa antes da Fase 2 de outro,
    // violando a Barreira de Sincronização definida no Manual §11.1.
    // ==========================================================================
    let historyProcessingChain = Promise.resolve();

    // 1. CONEXÃO
    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log(`⚡ [LISTENER] Conexão aberta!`);
            await updateSyncStatus(sessionId, 'importing_contacts', 5);
        }
        if (connection === 'close') {
            // 🧹 CLEANUP: Drena a fila isolada desta sessão ao desconectar.
            // Evita que tasks orfãs de uma instância destruída consumam memória/workers.
            drainSessionQueue(sessionId);
            console.log(`🧹 [LISTENER] Fila da sessão ${sessionId} drenada.`);
        }
    });

    // 2. PRESENÇA & CONTATOS
    sock.ev.on('presence.update', (update) => handlePresenceUpdate(update, companyId));
    
    sock.ev.on('contacts.upsert', async (contacts) => {
        // 1. Mantém a rotina original de salvar contatos
        handleContactsUpsert(contacts, companyId);
        
        // 2. 🛡️ [MAPA DE IDENTIDADE] O WhatsApp entrega a relação LID <-> Phone aqui
        try {
            const batch = contacts.filter(c => c.id && c.lid);
            if (batch.length > 0) {
                // Execução sequencial para evitar 'TypeError: fetch failed' (Socket Exhaustion)
                for (const contact of batch) {
                    const cleanPhone = contact.id.replace(/:[0-9]+@/, '@'); // Remove porta de dispositivo
                    const cleanLid = contact.lid.replace(/:[0-9]+@/, '@');

                    const { error: rpcError } = await supabase.rpc('link_identities', { 
                            p_lid: cleanLid, 
                            p_phone: cleanPhone, 
                            p_company_id: companyId 
                        });
                        if (rpcError) {
                            console.error("❌ [LISTENER] RPC Error:", rpcError.message);
                        }
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
        const nowSecs = Math.floor(Date.now() / 1000);

        for (const msg of messages) {
            // [PROTEÇÃO ETAPA 3] Se for 'append' (sincronização do celular) e for mais antiga que 7 dias, descarta.
            // Isso previne que o Baileys injete lixo histórico na fila de tempo real.
            const msgTs = Number(msg.messageTimestamp);
            if (!isRealtime && msgTs && (nowSecs - msgTs > 604800)) {
                continue;
            }
            
            enqueueMessage(msg, sock, companyId, sessionId, isRealtime);
        }
    });

    sock.ev.on('messages.update', (updates) => handleMessageUpdate(updates, companyId));
    sock.ev.on('message-receipt.update', (events) => handleReceiptUpdate(events, companyId));
    sock.ev.on('messages.reaction', (reactions) => handleReaction(reactions, sock, companyId));

    // 4. GRUPOS E COMUNIDADES [NOVO]
    // Responsável por captar hierarquias quando o motor puxa dados da Meta
    sock.ev.on('groups.upsert', (groups) => handleGroupsUpsert(groups, companyId));
    sock.ev.on('groups.update', (groups) => handleGroupsUpsert(groups, companyId));

    // 5. HISTÓRICO (SYNC) — Barreira de Sincronização de 3 Fases
    //
    // CRÍTICO: O handler é enfileirado em vez de chamado diretamente.
    // O Baileys dispara o evento 'messaging-history.set' múltiplas vezes
    // (um por lote de dados do WhatsApp) de forma rápida e não-bloqueante.
    //
    // A cadeia de Promises (historyProcessingChain) garante que cada chunk
    // seja processado de forma SEQUENCIAL: o Chunk N+1 só começa quando o
    // Chunk N completar TODAS as 3 fases (LID → Contacts → Messages).
    //
    // Falhas individuais de um chunk são capturadas no .catch() local e não
    // quebram a fila — o próximo chunk ainda será processado.
    sock.ev.on('messaging-history.set', (data) => {
        historyChunkCounter++;
        const currentChunk = historyChunkCounter; // captura por closure para log correto
        
        historyProcessingChain = historyProcessingChain.then(() =>
            handleHistorySync(data, sock, sessionId, companyId, currentChunk)
        ).catch(err => {
            console.error(`❌ [LISTENER] Falha no chunk ${currentChunk} da fila de histórico:`, err.message);
        });
    });
};
