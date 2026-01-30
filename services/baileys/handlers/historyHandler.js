
import { upsertContact, ensureLeadExists, updateSyncStatus } from '../../crm/sync.js';
import { handleMessage } from './messageHandler.js';
import { unwrapMessage, normalizeJid } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 10;
const HISTORY_MONTHS_LIMIT = 8;
const processedHistoryChunks = new Set();

// Helper: Pausa para não sufocar o banco/CPU
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) {
        console.log(`⏩ [HISTÓRICO] Lote ${chunkCounter} já processado. Ignorando.`);
        return;
    }
    processedHistoryChunks.add(chunkKey);

    // Se já completou, não faz nada (proteção contra eventos tardios)
    const { data: currentInstance } = await supabase.from('instances')
        .select('sync_status')
        .eq('session_id', sessionId)
        .eq('company_id', companyId)
        .single();
        
    if (currentInstance?.sync_status === 'completed') return;

    // Atualiza progresso visual baseado no progresso nativo do Baileys (se disponível) ou estimativa
    const currentPercent = progress || (chunkCounter * 10 > 90 ? 90 : chunkCounter * 10);
    console.log(`📚 [HISTÓRICO] Lote ${chunkCounter} | Progresso: ${currentPercent}% | isLatest: ${isLatest}`);
    
    await updateSyncStatus(sessionId, 'processing_history', currentPercent);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: CONTATOS (BATCHING REAL - Lotes de 50)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            console.log(`👤 [SYNC] Processando ${contacts.length} contatos em lotes...`);
            
            const BATCH_SIZE = 50;
            for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                const batch = contacts.slice(i, i + BATCH_SIZE);
                
                // Processa o lote em paralelo
                await Promise.all(batch.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    const bestName = c.name || c.verifiedName || c.notify;
                    contactsMap.set(jid, { 
                        name: bestName, 
                        imgUrl: c.imgUrl, 
                        isFromBook: !!c.name,
                        lid: c.lid || null 
                    });

                    // Salva contato
                    await upsertContact(jid, companyId, bestName, c.imgUrl, !!c.name, c.lid);

                    // Cria Lead se necessário
                    if (!jid.includes('@g.us') && !jid.includes('@newsletter') && bestName) {
                        await ensureLeadExists(jid, companyId, bestName, sock.user?.id);
                    }
                }));

                // Pausa tática entre lotes para liberar conexões do Supabase
                await sleep(100); 
            }
        }

        // -----------------------------------------------------------
        // ETAPA 2: MENSAGENS (BATCHING POR CHAT)
        // -----------------------------------------------------------
        if (messages && messages.length > 0) {
            
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Agrupa mensagens por chat
            const chats = {}; 
            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) return;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return;

                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') return;

                if (!chats[jid]) chats[jid] = [];
                
                // Tenta recuperar nome do mapa de contatos
                const knownContact = contactsMap.get(jid);
                clean._forcedName = knownContact ? knownContact.name : clean.pushName;
                
                chats[jid].push(clean);
            });

            const chatJids = Object.keys(chats);
            console.log(`🔍 [SYNC] Analisando ${chatJids.length} conversas ativas...`);

            let totalImported = 0;

            // Processa cada chat sequencialmente para não sobrecarregar
            for (const jid of chatJids) {
                // Ordena e limita
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT);
                topMessages.reverse(); // Cronológico para salvar
                
                // Salva mensagens do chat
                for (const msg of topMessages) {
                    const options = { 
                        downloadMedia: true, 
                        fetchProfilePic: false // Já tentamos no passo 1, evita spam de requests
                    };
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    totalImported++;
                }
                
                // Respira a cada chat processado
                await sleep(50);
            }
            
            console.log(`📥 [SYNC] Lote finalizado. ${totalImported} msgs importadas.`);
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
        // Não relança erro para não matar o processo do Baileys, apenas loga.
    } finally {
        // SE FOR O ÚLTIMO LOTE: FINALIZA
        if (isLatest) {
            console.log(`✅ [HISTÓRICO] Sync TOTALMENTE Concluído! Liberando UI...`);
            await updateSyncStatus(sessionId, 'completed', 100);
            processedHistoryChunks.clear();
        }
    }
};
