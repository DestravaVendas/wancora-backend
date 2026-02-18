
import { upsertContactsBulk, updateSyncStatus, normalizeJid, upsertContact } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// [AJUSTE] Reduzido para 10 para permitir download seguro de mídia
const HISTORY_MSG_LIMIT = 10; 
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
    const CONCURRENCY = 3; 
    const DELAY = 800;
    
    (async () => {
        for (let i = 0; i < contacts.length; i += CONCURRENCY) {
            const chunk = contacts.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(async (c) => {
                try {
                    const newUrl = await sock.profilePictureUrl(c.jid, 'image').catch(() => null);
                    if (newUrl) {
                        // Atualiza apenas a foto
                        await upsertContact(c.jid, companyId, null, newUrl, false, null, false, null, { profile_pic_updated_at: new Date() });
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

    const estimatedProgress = progress || Math.min(10 + (chunkCounter * 2), 95);
    console.log(`📚 [SYNC] Lote ${chunkCounter} | Contatos Brutos: ${contacts?.length || 0} | Msgs: ${messages?.length || 0}`);
    
    await updateSyncStatus(sessionId, 'importing_contacts', estimatedProgress);

    try {
        const contactsMap = new Map();
        const contactsToFetchPic = [];

        // --- FASE 1: CARREGAR DADOS DA AGENDA ---
        if (contacts && contacts.length > 0) {
            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid || jid.includes('@lid') || jid === 'status@broadcast') continue;

                const phoneName = c.name || c.notify || c.verifiedName;
                const isFromBook = !!(c.name && c.name.trim().length > 0);

                contactsMap.set(jid, { 
                    jid,
                    name: phoneName, 
                    isFromBook: isFromBook,
                    imgUrl: c.imgUrl,
                    verifiedName: c.verifiedName
                });

                if (c.lid) {
                     supabase.rpc('link_identities', {
                        p_lid: normalizeJid(c.lid),
                        p_phone: jid,
                        p_company_id: companyId
                    }).then(() => {});
                }
            }
        }

        // --- FASE 2: MINERAÇÃO DE NOMES NAS MENSAGENS (NAME HARVESTER) ---
        // Essencial para recuperar nomes de contatos que não estão na agenda mas têm PushName
        if (messages && messages.length > 0) {
            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key) return;
                
                const remoteJid = normalizeJid(clean.key.remoteJid);
                const participant = clean.key.participant ? normalizeJid(clean.key.participant) : null;
                
                const targetJid = participant || remoteJid;

                if (targetJid && !targetJid.includes('status@broadcast') && clean.pushName) {
                    const existing = contactsMap.get(targetJid);
                    
                    // Se não existe, ou existe mas sem nome da agenda, usa o pushName
                    if (!existing || (!existing.isFromBook && !existing.name)) {
                        contactsMap.set(targetJid, {
                            jid: targetJid,
                            name: clean.pushName,
                            isFromBook: false,
                            imgUrl: existing?.imgUrl,
                            verifiedName: existing?.verifiedName
                        });
                    }
                }
            });
        }

        // --- FASE 3: PERSISTÊNCIA (CONTATOS ANTES DAS MENSAGENS) ---
        const bulkPayload = [];
        
        for (const [jid, data] of contactsMap.entries()) {
             const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
             const contactData = {
                jid: jid,
                phone: purePhone,
                company_id: companyId,
                updated_at: new Date()
            };

            if (data.isFromBook) {
                contactData.name = data.name;
            } else if (data.name) {
                contactData.push_name = data.name;
            }

            if (data.imgUrl) {
                contactData.profile_pic_url = data.imgUrl;
            } else {
                contactsToFetchPic.push({ jid, profile_pic_url: null });
            }

            if (data.verifiedName) {
                contactData.verified_name = data.verifiedName;
                contactData.is_business = true;
            }

            bulkPayload.push(contactData);
        }

        if (bulkPayload.length > 0) {
            const BATCH_SIZE = 500;
            for (let i = 0; i < bulkPayload.length; i += BATCH_SIZE) {
                await upsertContactsBulk(bulkPayload.slice(i, i + BATCH_SIZE));
            }
        }
            
        if (contactsToFetchPic.length > 0) {
            fetchProfilePicsInBackground(sock, contactsToFetchPic, companyId);
        }

        // --- FASE 4: MENSAGENS E LEADS ---
        if (messages && messages.length > 0) {
            await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress + 2);
            
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            const chats = {}; 
            
            messages.forEach(msg => {
                let clean;
                try { clean = unwrapMessage(msg); } catch(e) { return; } 

                if (!clean.key?.remoteJid) return;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return;

                const jid = normalizeJid(clean.key.remoteJid);
                if (!jid || jid === 'status@broadcast') return;

                if (!chats[jid]) chats[jid] = [];
                
                // Injeta nome resolvido para criação correta do lead
                const knownContact = contactsMap.get(jid);
                if (knownContact) {
                    clean._forcedName = knownContact.isFromBook ? knownContact.name : knownContact.name;
                } else {
                    clean._forcedName = clean.pushName;
                }
                
                chats[jid].push(clean);
            });

            const chatJids = Object.keys(chats);

            for (const jid of chatJids) {
                chats[jid].sort((a, b) => (Number(a.messageTimestamp) || 0) - (Number(b.messageTimestamp) || 0)); 
                const topMessages = chats[jid].slice(-HISTORY_MSG_LIMIT);
                
                const latestMsg = topMessages[topMessages.length - 1];
                if (latestMsg && latestMsg.messageTimestamp) {
                    const ts = new Date(Number(latestMsg.messageTimestamp) * 1000);
                    supabase.from('contacts').update({ last_message_at: ts }).eq('company_id', companyId).eq('jid', jid).then();
                }

                for (const msg of topMessages) {
                    try {
                        const options = { 
                            // [ATIVAÇÃO] Download de mídia ativado para histórico RECENTE
                            downloadMedia: true, 
                            fetchProfilePic: false, 
                            createLead: true 
                        };
                        
                        await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    } catch (msgError) {}
                }
                // [OTIMIZAÇÃO] Delay ligeiramente maior entre chats para dar tempo ao download de mídia
                await sleep(50); 
            }
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        if (isLatest) {
            console.log(`✅ [HISTÓRICO] Sincronização Total Concluída.`);
            await updateSyncStatus(sessionId, 'completed', 100);
            resetHistoryState(sessionId);
        }
    }
};
