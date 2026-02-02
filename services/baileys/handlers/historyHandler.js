
import { upsertContact, updateSyncStatus } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage, normalizeJid } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 10;
const HISTORY_MONTHS_LIMIT = 8;
const processedHistoryChunks = new Set();

// Helper: Pausa mínima apenas para não travar o Event Loop (0ms = setImmediate)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter, totalAccumulated) => {
    
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

    // LÓGICA DE PORCENTAGEM VISUAL:
    // Se o Baileys mandar progresso, usamos. Se não, usamos uma estimativa baseada nos chunks.
    // Mas NUNCA deixamos chegar a 100% antes do 'isLatest'.
    let visualProgress = progress || Math.min((chunkCounter * 5), 95);
    if (!isLatest && visualProgress >= 100) visualProgress = 99;

    console.log(`📚 [SYNC] Lote ${chunkCounter} | Msgs no Lote: ${messages?.length || 0} | Total Acumulado: ${totalAccumulated} | Baileys Progress: ${progress}%`);
    
    // Atualiza status no banco para a barra se mover
    await updateSyncStatus(sessionId, 'importing_messages', visualProgress);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: CONTATOS (Otimizado)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            const BATCH_SIZE = 100; // Aumentado para 100 para acelerar
            for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                const batch = contacts.slice(i, i + BATCH_SIZE);
                
                // Processamento Paralelo de Contatos
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

                    await upsertContact(jid, companyId, bestName, finalImgUrl, !!c.name, c.lid);
                }));
                
                // Pequena pausa para o banco respirar
                await sleep(5); 
            }
        }

        // -----------------------------------------------------------
        // ETAPA 2: MENSAGENS (Otimizado com Logs 2%)
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
            let processedInThisBatch = 0;
            const totalInThisBatch = messages.length; // Aproximado (pós filtro)

            // Log inicial do lote
            console.log(`📥 [SYNC] Processando ${totalInThisBatch} mensagens neste lote...`);

            // Processa conversas sequencialmente
            for (const jid of chatJids) {
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
                
                // Atualiza last_message_at
                const latestMsg = chats[jid][chats[jid].length - 1];
                if (latestMsg && latestMsg.messageTimestamp) {
                    const ts = new Date(Number(latestMsg.messageTimestamp) * 1000);
                    await supabase.from('contacts')
                        .update({ last_message_at: ts })
                        .eq('company_id', companyId)
                        .eq('jid', jid);
                }

                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT);
                topMessages.reverse(); 
                
                for (const msg of topMessages) {
                    try {
                        const options = { 
                            downloadMedia: true, 
                            fetchProfilePic: false,
                            createLead: true 
                        };
                        
                        await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                        processedInThisBatch++;

                        // --- LOG DE PROGRESSO REAL (2% em 2%) ---
                        const percent = Math.floor((processedInThisBatch / totalInThisBatch) * 100);
                        if (processedInThisBatch % Math.ceil(totalInThisBatch / 50) === 0) { // A cada ~2%
                            console.log(`⏳ [SYNC LOTE ${chunkCounter}] ${processedInThisBatch}/${totalInThisBatch} mensagens (${percent}%)`);
                        }

                    } catch (msgError) {
                        // Ignora erro individual
                    }
                }
                
                // Reduzido de 20ms para 1ms para acelerar o download
                await sleep(1); 
            }
            
            console.log(`✅ [SYNC LOTE ${chunkCounter}] ${processedInThisBatch}/${totalInThisBatch} mensagens (100%) - Lote Finalizado`);
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        // SE FOR O FIM (Flag isLatest do Baileys), MARCA COMO COMPLETO
        if (isLatest) {
            console.log(`🎉 [HISTÓRICO FINAL] Todos os lotes processados. Marcando como 100% Completo.`);
            
            // Força um pequeno delay para garantir que a UI pegue o 99% antes do 100%
            await sleep(500); 
            await updateSyncStatus(sessionId, 'completed', 100);
            
            processedHistoryChunks.clear();
        }
    }
};
