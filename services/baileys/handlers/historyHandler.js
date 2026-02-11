
import { upsertContactsBulk, updateSyncStatus, normalizeJid, upsertContact } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 20; // Limite para feedback visual rápido
const HISTORY_MONTHS_LIMIT = 6;
const processedHistoryChunks = new Set();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fetchProfilePicsInBackground = async (sock, contacts, companyId) => {
    // Roda em background, sem await crítico
    const CONCURRENCY = 10;
    const DELAY = 300;
    
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
        // MAPA DE MEMÓRIA (Fonte da Verdade Rápida)
        const contactsMap = new Map();
        const contactsToFetchPic = [];

        // =========================================================================
        // FASE 1: INDEXAÇÃO DE CONTATOS (MEMORY-FIRST)
        // =========================================================================
        if (contacts && contacts.length > 0) {
            const BATCH_SIZE = 500;
            const bulkPayload = [];

            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid) continue;

                // Link LID (Identity) em background
                if (c.lid) {
                     supabase.rpc('link_identities', {
                        p_lid: normalizeJid(c.lid),
                        p_phone: jid,
                        p_company_id: companyId
                    }).then(() => {});
                }
                
                if (jid.includes('@lid')) continue;

                // Lógica de Prioridade de Nome
                const bestName = c.name || c.notify || c.verifiedName;
                const isFromBook = !!(c.name && c.name.trim().length > 0);

                // [CRÍTICO] Popula o mapa de memória IMEDIATAMENTE
                // Isso permite que as mensagens usem este nome antes mesmo do banco terminar de salvar
                contactsMap.set(jid, { name: bestName, isFromBook: isFromBook });

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
                } else {
                    contactsToFetchPic.push({ jid, profile_pic_url: null });
                }

                if (c.verifiedName) {
                    contactData.verified_name = c.verifiedName;
                    contactData.is_business = true;
                }

                bulkPayload.push(contactData);
            }

            // Dispara salvamento no banco (AWAIT para integridade, mas sem Sleep artificial)
            if (bulkPayload.length > 0) {
                for (let i = 0; i < bulkPayload.length; i += BATCH_SIZE) {
                    const batch = bulkPayload.slice(i, i + BATCH_SIZE);
                    await upsertContactsBulk(batch);
                }
            }
            
            // Background Fetch de Fotos
            if (contactsToFetchPic.length > 0) {
                fetchProfilePicsInBackground(sock, contactsToFetchPic, companyId);
            }
        }

        // =========================================================================
        // FASE 2: PROCESSAMENTO DE MENSAGENS (COM INJEÇÃO DE NOME)
        // =========================================================================
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
                
                // [CRÍTICO] INJEÇÃO DE NOME DA AGENDA
                // Recupera o nome do contactsMap (Memória) que acabamos de criar.
                // Isso garante que o Lead seja criado com o nome correto ("Mãe", "João Padaria") 
                // mesmo se o banco de dados ainda estiver processando o upsert.
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
                // Ordena
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0)); 
                
                // Atualiza last_message_at (Fire and Forget)
                const latestMsg = chats[jid][0];
                if (latestMsg && latestMsg.messageTimestamp) {
                    const ts = new Date(Number(latestMsg.messageTimestamp) * 1000);
                    supabase.from('contacts').update({ last_message_at: ts }).eq('company_id', companyId).eq('jid', jid).then();
                }

                // Insere mensagens recentes
                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT).reverse(); 
                
                for (const msg of topMessages) {
                    try {
                        const options = { 
                            downloadMedia: false, 
                            fetchProfilePic: true, 
                            createLead: true 
                        };
                        
                        // Passamos msg._forcedName que vem direto da memória RAM (contactsMap)
                        await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    } catch (msgError) {}
                }
                // Yield para não travar o Event Loop
                await sleep(0); 
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
