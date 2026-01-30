
import { upsertContact, ensureLeadExists, updateSyncStatus } from '../../crm/sync.js';
import { handleMessage } from './messageHandler.js';
import { unwrapMessage, normalizeJid } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 10;
const HISTORY_MONTHS_LIMIT = 8;
const processedHistoryChunks = new Set();

// Helper para liberar o Event Loop
const breathe = () => new Promise(resolve => setImmediate(resolve));

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) {
        console.log(`⏩ [HISTÓRICO] Lote ${chunkCounter} já processado. Ignorando.`);
        return;
    }
    processedHistoryChunks.add(chunkKey);

    const { data: currentInstance } = await supabase.from('instances')
        .select('sync_status')
        .eq('session_id', sessionId)
        .eq('company_id', companyId)
        .single();
        
    if (currentInstance?.sync_status === 'completed') return;

    console.log(`📚 [HISTÓRICO] Smart Sync: Processando Lote ${chunkCounter} (Progresso: ${progress || '?'}%)...`);

    try {
        const contactsMap = new Map();

        // --- ETAPA 1: CONTATOS (Com Throttling) ---
        if (contacts && contacts.length > 0) {
            await updateSyncStatus(sessionId, 'importing_contacts', 10);
            console.log(`👤 [SMART SYNC] Processando ${contacts.length} contatos da agenda...`);

            // Processa em mini-lotes de 20 para não bloquear
            const BATCH_SIZE = 20;
            for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                const batch = contacts.slice(i, i + BATCH_SIZE);
                
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

                    await upsertContact(jid, companyId, bestName, c.imgUrl, !!c.name, c.lid);

                    if (!jid.includes('@g.us') && !jid.includes('@newsletter') && bestName) {
                        await ensureLeadExists(jid, companyId, bestName, sock.user?.id);
                    }
                }));
                
                // Libera o Event Loop
                await breathe();
            }
        }

        // --- ETAPA 2: MENSAGENS ---
        if (messages && messages.length > 0) {
            await updateSyncStatus(sessionId, 'importing_messages', 30);

            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            const chats = {}; 
            
            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) return;
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return;

                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') return;

                if (!chats[jid]) chats[jid] = [];
                const knownContact = contactsMap.get(jid);
                clean._forcedName = knownContact ? knownContact.name : clean.pushName;
                chats[jid].push(clean);
            });

            const chatJids = Object.keys(chats);
            console.log(`🔍 [SMART SYNC] Analisando ${chatJids.length} conversas ativas...`);

            let totalImported = 0;

            for (const jid of chatJids) {
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT);
                topMessages.reverse();
                
                for (const msg of topMessages) {
                    const options = { downloadMedia: true, fetchProfilePic: true };
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    totalImported++;
                }
                // Libera o Event Loop entre cada chat para evitar Timeout 408
                await breathe();
            }
            
            console.log(`📥 [SMART SYNC] Importadas ${totalImported} mensagens recentes.`);
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        if (isLatest) {
            await updateSyncStatus(sessionId, 'completed', 100);
            console.log(`✅ [HISTÓRICO] Smart Sync Finalizado.`);
            processedHistoryChunks.clear();
        }
    }
};
