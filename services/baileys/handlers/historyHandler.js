
import { upsertContactsBulk, updateSyncStatus, normalizeJid, upsertContact } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 15;
const HISTORY_MONTHS_LIMIT = 8;
const processedHistoryChunks = new Set();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Função Auxiliar Otimizada para download de fotos (Turbo Mode)
const fetchProfilePicsInBackground = async (sock, contacts, companyId) => {
    console.log(`🖼️ [BACKGROUND] Iniciando busca TURBO de fotos para ${contacts.length} contatos...`);
    
    // Configurações de Concorrência
    const CONCURRENCY = 15; // 15 requisições simultâneas
    const DELAY_BETWEEN_CHUNKS = 200; // 200ms entre blocos

    // Divide em chunks
    for (let i = 0; i < contacts.length; i += CONCURRENCY) {
        const chunk = contacts.slice(i, i + CONCURRENCY);
        
        // Processa o chunk em paralelo
        await Promise.all(chunk.map(async (c) => {
            if (!c.jid || c.jid.includes('@lid')) return;
            
            try {
                // Tenta pegar a URL
                const newUrl = await sock.profilePictureUrl(c.jid, 'image').catch(() => null);
                
                // Só atualiza se tiver URL válida e for diferente (opcional check, mas upsert já lida bem)
                if (newUrl) {
                    await upsertContact(c.jid, companyId, null, newUrl, false);
                }
            } catch (e) {
                // Erros de privacidade (401/403) são comuns, ignoramos silenciosamente
            }
        }));

        // Respiro para não tomar rate limit
        await sleep(DELAY_BETWEEN_CHUNKS);
    }

    console.log(`🖼️ [BACKGROUND] Busca TURBO de fotos concluída.`);
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
                    // Adiciona na lista de busca em background se não veio foto
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
            
            // DISPARA BUSCA DE FOTOS OTIMIZADA
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
                            // Tenta buscar foto se for mensagem recente
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
