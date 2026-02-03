
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
            console.log(`🔍 [HISTORY] Processando ${contacts.length} contatos recebidos do Baileys...`);
            
            const BATCH_SIZE = 500; // Supabase aguenta lotes grandes
            const bulkPayload = [];

            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid) continue;

                // Mapa de Identidade (LID -> Phone)
                if (c.lid) {
                     supabase.rpc('link_identities', {
                        p_lid: normalizeJid(c.lid),
                        p_phone: jid,
                        p_company_id: companyId
                    }).then(() => {});
                }
                
                // Se o JID for LID, não salva como contato visual na tabela contacts
                // Mas usamos a RPC acima para garantir o vinculo
                if (jid.includes('@lid')) continue;

                const bestName = c.name || c.verifiedName || c.notify;
                const isFromBook = !!(c.name && c.name.trim().length > 0);

                // Armazena no mapa para uso nas mensagens subsequentes (In-Memory Cache)
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

                // Aplica lógica de nomes da Agenda
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

            console.log(`📦 [HISTORY] Payload montado: ${bulkPayload.length} contatos válidos para salvar.`);

            // EXECUTAR BULK UPSERT
            for (let i = 0; i < bulkPayload.length; i += BATCH_SIZE) {
                const batch = bulkPayload.slice(i, i + BATCH_SIZE);
                console.log(`💾 [HISTORY] Enviando batch ${i/BATCH_SIZE + 1} (${batch.length} itens)...`);
                await upsertContactsBulk(batch);
                await sleep(50);
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
                
                // Name Injection: Se veio da agenda, injeta o nome na mensagem
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

                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT).reverse(); 
                
                for (const msg of topMessages) {
                    try {
                        const options = { 
                            downloadMedia: false, 
                            fetchProfilePic: false, // Desligado para acelerar, o Bulk já tentou pegar o que tinha
                            createLead: true 
                        };
                        
                        await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    } catch (msgError) {}
                }
                await sleep(5); // Delay mínimo
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
