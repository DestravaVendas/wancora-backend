
import { upsertContactsBulk, updateSyncStatus, normalizeJid } from '../../crm/sync.js'; 
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
    console.log(`📚 [SYNC] Lote ${chunkCounter} | Contatos: ${contacts?.length || 0} | Msgs: ${messages?.length || 0}`);
    await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: CONTATOS (BULK INSERT - VELOCIDADE MÁXIMA)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            const BATCH_SIZE = 250; // Lote maior para banco
            const bulkPayload = [];

            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid || jid.includes('@lid')) {
                    // Se for LID, apenas vincula
                    if (c.lid) {
                         supabase.rpc('link_identities', {
                            p_lid: normalizeJid(c.lid),
                            p_phone: jid,
                            p_company_id: companyId
                        }).then(() => {});
                    }
                    continue; 
                }

                // LÓGICA DE OURO DO NOME (Agenda > Business > PushName)
                const isFromBook = !!(c.name && c.name.trim().length > 0);
                const bestName = c.name || c.verifiedName || c.notify; 

                // Armazena no mapa para uso nas mensagens subsequentes
                contactsMap.set(jid, { 
                    name: bestName, 
                    imgUrl: c.imgUrl || null, 
                    isFromBook: isFromBook, 
                    lid: c.lid || null 
                });

                // PREPARA OBJETO PARA BULK
                const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
                
                const contactData = {
                    jid: jid,
                    phone: purePhone,
                    company_id: companyId,
                    updated_at: new Date()
                };

                if (isFromBook) {
                    contactData.name = bestName;
                } else if (bestName) {
                    contactData.push_name = bestName;
                }

                if (c.imgUrl) {
                    contactData.profile_pic_url = c.imgUrl;
                    contactData.profile_pic_updated_at = new Date();
                }

                if (c.verifiedName) {
                    contactData.verified_name = c.verifiedName;
                    contactData.is_business = true;
                }

                bulkPayload.push(contactData);
            }

            // EXECUTAR BULK UPSERT
            for (let i = 0; i < bulkPayload.length; i += BATCH_SIZE) {
                const batch = bulkPayload.slice(i, i + BATCH_SIZE);
                await upsertContactsBulk(batch);
                await sleep(20); // Pequeno respiro para o banco
            }
            
            // Só aguarda se foi o primeiro lote significativo
            if (chunkCounter === 1 || contacts.length > 500) {
                console.log("⏳ [SYNC] Aguardando persistência da agenda...");
                await sleep(1000); 
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
                
                // Name Injection & Trust Flag (Memory Lookup)
                const knownContact = contactsMap.get(jid);
                let isFromBookMsg = false;

                if (knownContact && knownContact.isFromBook) {
                    clean._forcedName = knownContact.name;
                    isFromBookMsg = true; // Flag vital para o messageHandler
                } else {
                    clean._forcedName = clean.pushName;
                }
                
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
                // Pequeno delay entre chats para não travar o loop
                if (chatJids.length > 50) await sleep(5); 
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
