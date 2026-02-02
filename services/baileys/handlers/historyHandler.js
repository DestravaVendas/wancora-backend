
import { upsertContact, updateSyncStatus, normalizeJid } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 15; // Limite seguro para não estourar memória
const HISTORY_MONTHS_LIMIT = 6; 

// Helper: Pausa para não bloquear o Event Loop do Node.js
const tick = () => new Promise(r => setImmediate(r));

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    // Atualiza progresso visual
    const currentProgress = isLatest ? 100 : (progress || 10);
    console.log(`📚 [SYNC] Processando Histórico... (${currentProgress}%)`);
    await updateSyncStatus(sessionId, 'importing_messages', currentProgress);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: SALVAR CONTATOS (Prioridade Máxima)
        // Precisamos salvar os contatos ANTES de salvar mensagens para ter nomes.
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            
            // Mapeia para processamento rápido
            contacts.forEach(c => {
                const jid = normalizeJid(c.id);
                if(jid) {
                    const bestName = c.name || c.verifiedName || c.notify;
                    contactsMap.set(jid, { name: bestName, imgUrl: c.imgUrl });
                }
            });

            // Processamento em Série (Chunks de 50) para garantir integridade do banco
            const BATCH_SIZE = 50;
            for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                const batch = contacts.slice(i, i + BATCH_SIZE);
                
                await Promise.all(batch.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    const bestName = c.name || c.verifiedName || c.notify;
                    
                    // Upsert com nome da agenda/notify
                    await upsertContact(jid, companyId, bestName, c.imgUrl || null, !!c.name, c.lid);
                }));

                await tick(); // Respira
            }
        }

        // -----------------------------------------------------------
        // ETAPA 2: PROCESSAR MENSAGENS
        // -----------------------------------------------------------
        if (messages && messages.length > 0) {
            
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Agrupa mensagens por Chat para processar conversa por conversa
            const chats = {}; 
            
            for (const msg of messages) {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) continue;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) continue;

                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') continue;

                if (!chats[jid]) chats[jid] = [];
                
                // Name Hunter: Se o contato não veio na lista 'contacts' mas veio na mensagem
                if (!contactsMap.has(jid) && clean.pushName) {
                    clean._forcedName = clean.pushName;
                } else if (contactsMap.has(jid)) {
                    clean._forcedName = contactsMap.get(jid).name;
                }

                chats[jid].push(clean);
            }

            const chatJids = Object.keys(chats);

            // Processa cada chat individualmente
            for (const jid of chatJids) {
                // Ordena (Antigas -> Recentes)
                chats[jid].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                
                // Pega apenas as últimas X mensagens
                const messagesToSave = chats[jid].slice(-HISTORY_MSG_LIMIT);
                
                // Atualiza data do contato para ordenação correta no frontend
                const lastMsg = messagesToSave[messagesToSave.length - 1];
                if (lastMsg) {
                    const ts = new Date(Number(lastMsg.messageTimestamp) * 1000);
                    // Atualiza data sem bloquear
                    supabase.from('contacts')
                        .update({ last_message_at: ts })
                        .eq('company_id', companyId)
                        .eq('jid', jid)
                        .then(() => {});
                }

                // Salva mensagens
                for (const msg of messagesToSave) {
                    // Configurações de Sync:
                    // - downloadMedia: false (Economiza banda no histórico)
                    // - createLead: true (Garante que chats ativos apareçam no Kanban/Lista)
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, { 
                        downloadMedia: false, 
                        fetchProfilePic: true, // Tenta buscar foto se não tiver
                        createLead: true 
                    });
                }
                
                await tick();
            }
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        if (isLatest) {
            console.log(`✅ [HISTÓRICO] Sincronização Finalizada.`);
            await updateSyncStatus(sessionId, 'completed', 100);
        }
    }
};
