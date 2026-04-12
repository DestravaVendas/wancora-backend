
import { upsertContactsBulk, updateSyncStatus, normalizeJid, upsertContact } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// [AJUSTE] Definido para 10 mensagens conforme solicitado pelo usuário
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
    console.log(`📚 [SYNC] Lote ${chunkCounter} | Processando Camadas...`);
    
    await updateSyncStatus(sessionId, 'importing_contacts', estimatedProgress);

    try {
        const contactsMap = new Map();
        const identityPayload = [];

        // --- CAMADA 1: IDENTIDADE (LID -> PHONE) ---
        // Extraímos todos os vínculos de identidade antes de qualquer outra coisa
        if (contacts && contacts.length > 0) {
            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid || jid === 'status@broadcast') continue;

                if (c.lid) {
                    const cleanLid = normalizeJid(c.lid);
                    if (cleanLid !== jid) {
                        identityPayload.push({
                            lid_jid: cleanLid,
                            phone_jid: jid,
                            company_id: companyId,
                            created_at: new Date()
                        });
                        // Mapeamento duplo para garantir resolução em ambos os domínios
                        if (cleanLid.includes('@s.whatsapp.net')) {
                            identityPayload.push({
                                lid_jid: cleanLid.replace('@s.whatsapp.net', '@lid'),
                                phone_jid: jid,
                                company_id: companyId,
                                created_at: new Date()
                            });
                        }
                    }
                }

                const phoneName = c.name || c.notify || c.verifiedName;
                contactsMap.set(jid, { 
                    jid,
                    name: phoneName, 
                    isFromBook: !!(c.name && c.name.trim().length > 0),
                    imgUrl: c.imgUrl,
                    verifiedName: c.verifiedName
                });
            }
        }

        // Persistência imediata da identidade (Hard Link)
        if (identityPayload.length > 0) {
            const ID_CHUNK = 500;
            for (let i = 0; i < identityPayload.length; i += ID_CHUNK) {
                await supabase.from('identity_map').upsert(identityPayload.slice(i, i + ID_CHUNK), { onConflict: 'lid_jid, company_id' });
            }
        }

        // --- CAMADA 2: CONTATOS (PERSISTÊNCIA) ---
        const bulkPayload = [];
        for (const [jid, data] of contactsMap.entries()) {
            const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
            const contactData = {
                jid: jid,
                phone: purePhone.length <= 13 ? purePhone : null,
                company_id: companyId,
                updated_at: new Date()
            };

            if (data.isFromBook) contactData.name = data.name;
            else if (data.name) contactData.push_name = data.name;

            if (data.imgUrl) contactData.profile_pic_url = data.imgUrl;
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

        // --- CAMADA 3: MENSAGENS (POR ÚLTIMO) ---
        if (messages && messages.length > 0) {
            await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress + 2);
            
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Agrupa por chat para processamento ordenado
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
                chats[jid].push(clean);
            });

            for (const jid of Object.keys(chats)) {
                // Ordena mensagens por tempo
                chats[jid].sort((a, b) => (Number(a.messageTimestamp) || 0) - (Number(b.messageTimestamp) || 0)); 
                const topMessages = chats[jid].slice(-HISTORY_MSG_LIMIT);
                
                for (const msg of topMessages) {
                    try {
                        // handleMessage agora usará o resolveJid refatorado da Etapa 1
                        await handleMessage(msg, sock, companyId, sessionId, false, null, { 
                            downloadMedia: true, 
                            createLead: true 
                        });
                    } catch (msgError) {}
                }
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
