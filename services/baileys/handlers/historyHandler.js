
import { upsertContactsBulk, updateSyncStatus, normalizeJid, upsertContact } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 25; // Aumentado levemente
const HISTORY_MONTHS_LIMIT = 6;
const processedHistoryChunks = new Set();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const resetHistoryState = (sessionId) => {
    for (const key of processedHistoryChunks) {
        if (key.startsWith(sessionId)) {
            processedHistoryChunks.delete(key);
        }
    }
};

const fetchProfilePicsInBackground = async (sock, contacts, companyId) => {
    const CONCURRENCY = 5; // Reduzido para evitar rate-limit do WhatsApp
    const DELAY = 500;
    
    (async () => {
        for (let i = 0; i < contacts.length; i += CONCURRENCY) {
            const chunk = contacts.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(async (c) => {
                try {
                    const newUrl = await sock.profilePictureUrl(c.jid, 'image').catch(() => null);
                    if (newUrl) {
                        await upsertContact(c.jid, companyId, null, newUrl, false);
                    }
                } catch (e) {}
            }));
            await sleep(DELAY);
        }
    })();
};

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) return;
    processedHistoryChunks.add(chunkKey);

    const estimatedProgress = progress || Math.min((chunkCounter * 3), 99);
    console.log(`📚 [SYNC] Lote ${chunkCounter} | Contatos: ${contacts?.length || 0} | Msgs: ${messages?.length || 0}`);
    await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress);

    try {
        const contactsMap = new Map();
        const contactsToFetchPic = [];

        // 1. CONTATOS (Prioridade Máxima e Bloqueante)
        if (contacts && contacts.length > 0) {
            const bulkPayload = [];

            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid || jid.includes('@lid')) continue;

                // Salva na memória para uso rápido nas mensagens
                const bestName = c.name || c.notify || c.verifiedName;
                const isFromBook = !!(c.name && c.name.trim().length > 0);
                contactsMap.set(jid, { name: bestName, isFromBook: isFromBook });

                // Link Identity em Background
                if (c.lid) {
                     supabase.rpc('link_identities', {
                        p_lid: normalizeJid(c.lid),
                        p_phone: jid,
                        p_company_id: companyId
                    }).then(() => {});
                }

                // Prepara Payload DB
                const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
                const contactData = {
                    jid: jid,
                    phone: purePhone,
                    company_id: companyId,
                    updated_at: new Date()
                };

                if (isFromBook) contactData.name = bestName;
                else if (bestName) contactData.push_name = bestName;

                if (c.imgUrl) {
                    contactData.profile_pic_url = c.imgUrl;
                    contactData.profile_pic_updated_at = new Date();
                } else {
                    contactsToFetchPic.push({ jid, profile_pic_url: null });
                }

                if (c.verifiedName) {
                    contactData.verified_name = c.verifiedName;
                    contactData.is_business = true;
                }

                bulkPayload.push(contactData);
            }

            // Upsert Bloqueante (Garante integridade FK)
            if (bulkPayload.length > 0) {
                const BATCH_SIZE = 500;
                for (let i = 0; i < bulkPayload.length; i += BATCH_SIZE) {
                    await upsertContactsBulk(bulkPayload.slice(i, i + BATCH_SIZE));
                }
            }
            
            // Fotos em paralelo
            if (contactsToFetchPic.length > 0) {
                fetchProfilePicsInBackground(sock, contactsToFetchPic, companyId);
            }
        }

        // 2. MENSAGENS (Processamento com Filtro e Try/Catch Isolado)
        if (messages && messages.length > 0) {
            
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Agrupa por Chat para pegar apenas as últimas
            const chats = {}; 
            
            messages.forEach(msg => {
                // Tenta desembrulhar com segurança
                let clean;
                try {
                    clean = unwrapMessage(msg);
                } catch(e) { return; } // Pula mensagem corrompida

                if (!clean.key?.remoteJid) return;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return;

                const jid = normalizeJid(clean.key.remoteJid);
                if (!jid || jid === 'status@broadcast') return;

                if (!chats[jid]) chats[jid] = [];
                
                // Injeta nome conhecido da memória (sem ir no banco)
                const knownContact = contactsMap.get(jid);
                if (knownContact && knownContact.isFromBook) {
                    clean._forcedName = knownContact.name;
                } else {
                    clean._forcedName = clean.pushName;
                }
                
                chats[jid].push(clean);
            });

            const chatJids = Object.keys(chats);

            for (const jid of chatJids) {
                // Ordena por data
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0)); 
                
                // Pega apenas as N últimas
                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT).reverse(); 
                
                // Atualiza data da conversa (Fire and Forget)
                const latestMsg = topMessages[topMessages.length - 1];
                if (latestMsg && latestMsg.messageTimestamp) {
                    const ts = new Date(Number(latestMsg.messageTimestamp) * 1000);
                    supabase.from('contacts').update({ last_message_at: ts }).eq('company_id', companyId).eq('jid', jid).then();
                }

                for (const msg of topMessages) {
                    try {
                        const options = { 
                            downloadMedia: false, 
                            fetchProfilePic: false, // Já foi feito no loop de contatos
                            createLead: true 
                        };
                        
                        await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    } catch (msgError) {
                        // Log leve para não poluir
                        // console.warn(`[SYNC] Falha ao processar msg histórica ${msg.key?.id} (Ignorada).`);
                    }
                }
                // Pequeno respiro para o Event Loop
                await sleep(5); 
            }
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        if (isLatest) {
            console.log(`✅ [HISTÓRICO] Sincronização 100% Concluída.`);
            await updateSyncStatus(sessionId, 'completed', 100);
            resetHistoryState(sessionId);
        }
    }
};
