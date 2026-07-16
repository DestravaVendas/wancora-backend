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
        // 1. Mantém a rotina original de salvar contatos (Que agora também gerencia LID internamente via upsertContact)
        handleContactsUpsert(contacts, companyId);
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

    // 6. ETIQUETAS (LABELS) DO WHATSAPP BUSINESS
    sock.ev.on('labels.edit', async (label) => {
        console.log(`🏷️ [LISTENER] Evento de etiqueta recebido:`, label);
        try {
            if (label.deleted) {
                await supabase.from('wa_labels').delete().eq('company_id', companyId).eq('label_id', label.id);
            } else {
                await supabase.from('wa_labels').upsert({
                    company_id: companyId,
                    label_id: label.id,
                    name: label.name,
                    color: label.color,
                    updated_at: new Date()
                }, { onConflict: 'company_id, label_id' });
            }
        } catch (e) {
            console.error("❌ Erro ao atualizar etiqueta:", e.message);
        }
    });

    sock.ev.on('labels.association', async ({ type, association }) => {
        // Quando uma etiqueta é associada a um chat/mensagem no celular
        console.log(`🏷️ [LISTENER] Associação de etiqueta:`, type, association);
        if (type === 'chat' && association.chatId && association.labelId) {
             try {
                 // Busca os labels atuais
                 const { data } = await supabase.from('contacts').select('wa_labels').eq('jid', association.chatId).eq('company_id', companyId).maybeSingle();
                 let labels = data?.wa_labels || [];
                 
                 // Pode ser 'add' ou 'remove' (ou unassociated)
                 const action = association.type || 'add'; 
                 let changed = false;

                 if (action === 'add' && !labels.includes(association.labelId)) {
                     labels.push(association.labelId);
                     changed = true;
                 } else if (action === 'remove' && labels.includes(association.labelId)) {
                     labels = labels.filter(id => id !== association.labelId);
                     changed = true;
                 }

                 if (changed) {
                     await supabase.from('contacts').update({ wa_labels: labels }).eq('jid', association.chatId).eq('company_id', companyId);
                 }
             } catch (e) {
                 console.error("❌ Erro ao salvar associação de etiqueta:", e);
             }
        }
    });
};
