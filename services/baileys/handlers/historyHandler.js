
import { upsertContact, updateSyncStatus, normalizeJid } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 15;
const HISTORY_MONTHS_LIMIT = 8;
const processedHistoryChunks = new Set();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) return;
    processedHistoryChunks.add(chunkKey);

    const estimatedProgress = progress || Math.min((chunkCounter * 2), 99);
    console.log(`📚 [SYNC] Lote ${chunkCounter} | Progresso: ${estimatedProgress}% | Latest: ${isLatest}`);
    await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: CONTATOS (AGENDA - PRIORIDADE MÁXIMA)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            const BATCH_SIZE = 50;
            for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                const batch = contacts.slice(i, i + BATCH_SIZE);
                
                await Promise.all(batch.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    if (c.lid) {
                        supabase.rpc('link_identities', {
                            p_lid: normalizeJid(c.lid),
                            p_phone: jid,
                            p_company_id: companyId
                        }).then(() => {});
                    }

                    if (jid.includes('@lid')) return;

                    const isFromBook = !!(c.name && c.name.trim().length > 0);
                    const bestName = c.name || c.verifiedName || c.notify; 

                    let finalImgUrl = c.imgUrl || null;
                    if (!finalImgUrl && !jid.includes('@newsletter') && !jid.includes('status@broadcast')) {
                        try {
                            await sleep(Math.floor(Math.random() * 150)); 
                            finalImgUrl = await sock.profilePictureUrl(jid, 'image');
                        } catch (e) {
                            finalImgUrl = null;
                        }
                    }

                    contactsMap.set(jid, { 
                        name: bestName, 
                        imgUrl: finalImgUrl, 
                        isFromBook: isFromBook, 
                        lid: c.lid || null 
                    });

                    // Upsert IMEDIATO 
                    await upsertContact(jid, companyId, bestName, finalImgUrl, isFromBook, c.lid);
                }));
                
                await sleep(50); 
            }
            
            if (chunkCounter === 1) {
                console.log("⏳ [SYNC] Aguardando indexação da agenda...");
                await sleep(1500); 
            }
        }

        // -----------------------------------------------------------
        // ETAPA 2: MENSAGENS
        // -----------------------------------------------------------
        if (messages && messages.length > 0) {
            
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
                
                // Name Injection & Trust Flag
                const knownContact = contactsMap.get(jid);
                let isFromBookMsg = false;

                if (knownContact && knownContact.isFromBook) {
                    clean._forcedName = knownContact.name;
                    isFromBookMsg = true; // Flag vital para o messageHandler
                } else {
                    clean._forcedName = clean.pushName;
                }
                
                // Anexa a flag diretamente no objeto (embora passemos via options, é bom ter)
                clean._isFromBook = isFromBookMsg;

                chats[jid].push(clean);
            });

            const chatJids = Object.keys(chats);

            for (const jid of chatJids) {
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0)); 
                
                const latestMsg = chats[jid][0];
                if (latestMsg && latestMsg.messageTimestamp) {
                    const ts = new Date(Number(latestMsg.messageTimestamp) * 1000);
                    supabase.from('contacts').update({ last_message_at: ts }).eq('company_id', companyId).eq('jid', jid).then();
                }

                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT).reverse(); 
                
                for (const msg of topMessages) {
                    try {
                        const options = { 
                            downloadMedia: false, 
                            fetchProfilePic: false,
                            createLead: true,
                            isFromBook: msg._isFromBook // Passa a confiança aqui
                        };
                        
                        await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    } catch (msgError) {}
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
