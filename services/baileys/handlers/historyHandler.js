
import { upsertContact, updateSyncStatus, normalizeJid } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 15; // Equilíbrio entre carga e contexto
const HISTORY_MONTHS_LIMIT = 8;
const processedHistoryChunks = new Set();

// Helper: Pausa para não sufocar o banco/CPU
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    // Evita processar o mesmo chunk duas vezes (Anti-Duplication)
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) return;
    processedHistoryChunks.add(chunkKey);

    // UX: Progresso linear
    const estimatedProgress = progress || Math.min((chunkCounter * 2), 99);
    console.log(`📚 [SYNC] Lote ${chunkCounter} | Progresso: ${estimatedProgress}% | Latest: ${isLatest}`);
    await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: CONTATOS (Lotes de 50)
        // Restauração do "Smart Fetch" original que busca fotos
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            const BATCH_SIZE = 50;
            for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                const batch = contacts.slice(i, i + BATCH_SIZE);
                
                await Promise.all(batch.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    const bestName = c.name || c.verifiedName || c.notify;
                    
                    // --- SMART FETCH DE FOTO (Lógica Original Restaurada) ---
                    let finalImgUrl = c.imgUrl || null;

                    // Se não veio foto no pacote, tenta buscar ativamente
                    if (!finalImgUrl && !jid.includes('@newsletter')) {
                        try {
                            // Pequeno delay aleatório para não tomar ban por flood de requests
                            await sleep(Math.floor(Math.random() * 200)); 
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

                    // Upsert seguro
                    await upsertContact(jid, companyId, bestName, finalImgUrl, !!c.name, c.lid);
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
                
                // Name Injection: Se temos o nome da etapa 1, injetamos na mensagem
                const knownContact = contactsMap.get(jid);
                clean._forcedName = knownContact ? knownContact.name : clean.pushName;
                
                chats[jid].push(clean);
            });

            const chatJids = Object.keys(chats);

            // Processa conversas sequencialmente para não matar o banco
            for (const jid of chatJids) {
                // Ordena cronologicamente
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0)); // Desc
                
                // Atualiza data da conversa
                const latestMsg = chats[jid][0];
                if (latestMsg && latestMsg.messageTimestamp) {
                    const ts = new Date(Number(latestMsg.messageTimestamp) * 1000);
                    // Fire and forget update
                    supabase.from('contacts').update({ last_message_at: ts }).eq('company_id', companyId).eq('jid', jid).then();
                }

                // Pega apenas as N últimas para salvar no banco
                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT).reverse(); // Asc para salvar
                
                for (const msg of topMessages) {
                    try {
                        const options = { 
                            downloadMedia: false, // Não baixa mídia no histórico (economia)
                            fetchProfilePic: false, // Já fizemos na Etapa 1
                            createLead: true // Cria lead se tiver interação
                        };
                        
                        await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    } catch (msgError) {
                        // Ignora erro individual
                    }
                }
                
                await sleep(10); 
            }
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        if (isLatest) {
            console.log(`✅ [HISTÓRICO] Sincronização 100% Concluída.`);
            await updateSyncStatus(sessionId, 'completed', 100);
            processedHistoryChunks.clear();
        }
    }
};
