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
        return;
    }
    processedHistoryChunks.add(chunkKey);

    // Se já completou no banco, aborta (Fast Exit)
    const { data: currentInstance } = await supabase.from('instances')
        .select('sync_status')
        .eq('session_id', sessionId)
        .eq('company_id', companyId)
        .single();
        
    if (currentInstance?.sync_status === 'completed') return;

    // Calcula progresso estimado se o Baileys não enviar
    const estimatedProgress = progress || Math.min((chunkCounter * 5), 99);
    console.log(`📚 [SYNC] Lote ${chunkCounter} | Progresso: ${estimatedProgress}% | Latest: ${isLatest}`);
    
    // Atualiza status no banco para a barra se mover
    await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: CONTATOS (Lotes de 50)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            const BATCH_SIZE = 50;
            for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                const batch = contacts.slice(i, i + BATCH_SIZE);
                
                await Promise.all(batch.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    const bestName = c.name || c.verifiedName || c.notify;
                    
                    // --- SMART FETCH DE FOTO (FIX) ---
                    let finalImgUrl = c.imgUrl || null;

                    if (!finalImgUrl) {
                        try {
                            finalImgUrl = await sock.profilePictureUrl(jid, 'image');
                        } catch (e) {
                            finalImgUrl = null;
                        }
                    }

                    contactsMap.set(jid, { 
                        name: bestName, 
                        imgUrl: finalImgUrl, 
                        isFromBook: !!c.name,
                        lid: c.lid || null 
                    });

                    // Upsert seguro com a URL correta
                    await upsertContact(jid, companyId, bestName, finalImgUrl, !!c.name, c.lid);
                    
                    // CRÍTICO: Tenta criar Lead para TODOS (ensureLeadExists filtra grupos/ignores internamente)
                    // Removemos a verificação `&& bestName` para garantir que números sem nome também virem leads
                    await ensureLeadExists(jid, companyId, bestName, sock.user?.id);
                }));
                
                await sleep(50); // Respira
            }
        }

        // -----------------------------------------------------------
        // ETAPA 2: MENSAGENS (Por Conversa)
        // -----------------------------------------------------------
        if (messages && messages.length > 0) {
            
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Agrupa por chat
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

            // Processa conversas sequencialmente para não matar o banco
            for (const jid of chatJids) {
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT);
                topMessages.reverse(); 
                
                for (const msg of topMessages) {
                    try {
                        const options = { 
                            downloadMedia: true, 
                            fetchProfilePic: false // Já buscamos no passo 1
                        };
                        await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    } catch (msgError) {
                        // Ignora erro individual
                    }
                }
                
                await sleep(20); 
            }
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        // SE FOR O FIM, MARCA COMO COMPLETO
        if (isLatest) {
            console.log(`✅ [HISTÓRICO] Sincronização 100% Concluída.`);
            await updateSyncStatus(sessionId, 'completed', 100);
            processedHistoryChunks.clear();
        }
    }
};
