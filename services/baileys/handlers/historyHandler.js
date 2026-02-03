
import { upsertContactsBulk, updateSyncStatus, normalizeJid, upsertContact } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 15;
const HISTORY_MONTHS_LIMIT = 8;
const processedHistoryChunks = new Set();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Função Auxiliar para buscar fotos em background (Detached)
const fetchProfilePicsInBackground = async (sock, contacts, companyId) => {
    console.log(`🖼️ [BACKGROUND] Iniciando busca de fotos para ${contacts.length} contatos...`);
    
    // Processa um por um com delay para não tomar Ban por rate limit
    for (const c of contacts) {
        if (!c.jid || c.jid.includes('@lid')) continue;
        
        try {
            // Só busca se não tiver URL já salva (o Baileys as vezes manda no objeto inicial)
            if (!c.profile_pic_url) {
                const newUrl = await sock.profilePictureUrl(c.jid, 'image').catch(() => null);
                
                if (newUrl) {
                    await upsertContact(c.jid, companyId, null, newUrl, false);
                }
                // Delay de segurança entre requests de foto
                await sleep(500); 
            }
        } catch (e) {
            // Ignora erros de privacidade/404
        }
    }
    console.log(`🖼️ [BACKGROUND] Busca de fotos concluída.`);
};

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) return;
    processedHistoryChunks.add(chunkKey);

    const estimatedProgress = progress || Math.min((chunkCounter * 2), 99);
    console.log(`📚 [SYNC] Lote ${chunkCounter} | Contatos: ${contacts?.length || 0} | Msgs: ${messages?.length || 0}`);
    await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress);

    try {
        const contactsMap = new Map();
        const contactsToFetchPic = [];

        // -----------------------------------------------------------
        // ETAPA 1: CONTATOS (BULK INSERT)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            const BATCH_SIZE = 500;
            const bulkPayload = [];

            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid) continue;

                if (c.lid) {
                     supabase.rpc('link_identities', {
                        p_lid: normalizeJid(c.lid),
                        p_phone: jid,
                        p_company_id: companyId
                    }).then(() => {});
                }
                
                if (jid.includes('@lid')) continue;

                // Cache para uso nas mensagens
                const bestName = c.name || c.verifiedName || c.notify;
                const isFromBook = !!(c.name && c.name.trim().length > 0);

                contactsMap.set(jid, { 
                    name: bestName, 
                    isFromBook: isFromBook 
                });

                // PREPARA OBJETO PARA BULK
                const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
                const contactData = {
                    jid: jid,
                    phone: purePhone,
                    company_id: companyId,
                    updated_at: new Date()
                };

                // Lógica de nomes permissiva
                if (isFromBook) {
                    contactData.name = bestName;
                } else if (bestName) {
                    contactData.push_name = bestName;
                }

                if (c.imgUrl) {
                    contactData.profile_pic_url = c.imgUrl;
                    contactData.profile_pic_updated_at = new Date();
                } else {
                    // Se não tem foto, adiciona na lista para buscar em background
                    contactsToFetchPic.push({ jid, profile_pic_url: null });
                }

                if (c.verifiedName) {
                    contactData.verified_name = c.verifiedName;
                    contactData.is_business = true;
                }

                bulkPayload.push(contactData);
            }

            console.log(`📦 [HISTORY] Contatos preparados: ${bulkPayload.length}`);

            // SALVA NO BANCO PRIMEIRO (Prioridade Imediata)
            for (let i = 0; i < bulkPayload.length; i += BATCH_SIZE) {
                const batch = bulkPayload.slice(i, i + BATCH_SIZE);
                await upsertContactsBulk(batch);
                await sleep(50);
            }
            
            // DISPARA BUSCA DE FOTOS (Segundo Plano - Não espera terminar)
            if (contactsToFetchPic.length > 0) {
                fetchProfilePicsInBackground(sock, contactsToFetchPic, companyId);
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
                
                // Name Injection
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
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0)); 
                
                const latestMsg = chats[jid][0];
                if (latestMsg && latestMsg.messageTimestamp) {
                    const ts = new Date(Number(latestMsg.messageTimestamp) * 1000);
                    supabase.from('contacts').update({ last_message_at: ts }).eq('company_id', companyId).eq('jid', jid).then();
                }

                // Processa apenas as N últimas mensagens
                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT).reverse(); 
                
                for (const msg of topMessages) {
                    try {
                        const options = { 
                            downloadMedia: false, 
                            // IMPORTANTE: Tenta buscar foto se for mensagem recente e não tivermos ainda.
                            // Isso garante que os chats ativos fiquem bonitos mais rápido que o background job.
                            fetchProfilePic: true, 
                            createLead: true 
                        };
                        
                        await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    } catch (msgError) {}
                }
                await sleep(5); 
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
