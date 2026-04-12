import { upsertContactsBulk, updateSyncStatus, normalizeJid, upsertContact, resolveJid } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';
import { Logger } from '../../../utils/logger.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 50; // Aumentado para garantir mais contexto
const processedHistoryChunks = new Set();

export const resetHistoryState = (sessionId) => {
    // Limpa o cache de chunks processados para esta sessão
    for (const key of processedHistoryChunks) {
        if (key.startsWith(sessionId)) processedHistoryChunks.delete(key);
    }
};

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) {
        Logger.warn('sync', `Chunk ${chunkCounter} para ${sessionId} já processado. Ignorando.`, { companyId });
        return;
    }
    processedHistoryChunks.add(chunkKey);

    Logger.info('sync', `[SYNC] Lote ${chunkCounter} | Iniciando Mineração de Dados...`, { companyId, sessionId });
    
    try {
        const contactsMap = new Map();
        const identityPayload = [];

        // --- CAMADA 1: EXTRAÇÃO DE CONTATOS (Array Oficial) --- 
        if (contacts && contacts.length > 0) {
            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid || jid.includes('@broadcast')) continue;

                // Mapeia LIDs para telefones, crucial para unificação
                if (c.lid) {
                    const cleanLid = normalizeJid(c.lid);
                    identityPayload.push({ lid_jid: cleanLid, phone_jid: jid, company_id: companyId });
                }

                contactsMap.set(jid, {
                    jid,
                    name: c.name || c.notify || c.verifiedName, 
                    isFromBook: !!c.name,
                    imgUrl: c.imgUrl || null
                });
            }
        }

        // --- CAMADA 2: MINERAÇÃO DE MENSAGENS (Fallback de Identidade e Contatos) ---
        if (messages && messages.length > 0) {
            for (const msg of messages) {
                const clean = unwrapMessage(msg);
                const jid = normalizeJid(clean.key.remoteJid);
                if (!jid || jid.includes('@broadcast')) continue;

                // Se a mensagem tem um LID no participante (em grupos), mapeia também
                if (clean.key.participant && clean.key.participant.includes('@lid')) {
                    // Infelizmente aqui não temos o telefone correspondente fácil, 
                    // mas o Baileys emitirá o identity-map.update depois.
                }

                if (!contactsMap.has(jid)) {
                    contactsMap.set(jid, {
                        jid,
                        name: clean.pushName || null,
                        isFromBook: false,
                        imgUrl: null
                    });
                }
            }
        }

        // 1. Persistência de Identidade (LID -> Phone) - DEVE SER PRIMEIRO
        if (identityPayload.length > 0) {
            await supabase.from('identity_map').upsert(identityPayload, { onConflict: 'lid_jid, company_id' });
            Logger.info('sync', `[SYNC] ${identityPayload.length} LIDs mapeados para ${sessionId}.`, { companyId, sessionId });
        }

        // 2. Persistência de Contatos em Lote
        if (contactsMap.size > 0) {
            const bulkContacts = [];
            const myJid = normalizeJid(sock.user?.id);

            for (const c of contactsMap.values()) {
                // Resolve JID (LID -> Phone) antes de salvar o contato
                const resolvedJid = await resolveJid(c.jid, companyId, myJid);
                
                bulkContacts.push({
                    jid: resolvedJid,
                    company_id: companyId,
                    name: c.isFromBook ? c.name : null,
                    push_name: !c.isFromBook ? c.name : null,
                    profile_pic_url: c.imgUrl,
                    phone: resolvedJid.split('@')[0].replace(/\D/g, ''),
                    updated_at: new Date()
                });

                // 🔥 [MELHORIA] Se não tem foto, tenta buscar (Background)
                if (!c.imgUrl && !resolvedJid.includes('@g.us')) {
                    sock.profilePictureUrl(resolvedJid, 'image').then(url => {
                        if (url) {
                            supabase.from('contacts')
                                .update({ profile_pic_url: url, profile_pic_updated_at: new Date() })
                                .eq('jid', resolvedJid)
                                .eq('company_id', companyId)
                                .then(() => {});
                        }
                    }).catch(() => {});
                }
            }
            await upsertContactsBulk(bulkContacts);
            Logger.info('sync', `[SYNC] ${bulkContacts.length} contatos upserted para ${sessionId}.`, { companyId, sessionId });
        }

        // --- CAMADA 3: PROCESSAMENTO DE MENSAGENS --- 
        if (messages && messages.length > 0) {
            const chats = {};
            messages.forEach(m => {
                const clean = unwrapMessage(m);
                const jid = normalizeJid(clean.key.remoteJid);
                if (!jid) return;
                if (!chats[jid]) chats[jid] = [];
                chats[jid].push(clean);
            });

            for (const jid of Object.keys(chats)) {
                chats[jid].sort((a, b) => (Number(a.messageTimestamp) || 0) - (Number(b.messageTimestamp) || 0));
                const recentMsgs = chats[jid].slice(-HISTORY_MSG_LIMIT);
                
                for (const msg of recentMsgs) {
                    await handleMessage(msg, sock, companyId, sessionId, false, null, { 
                        downloadMedia: true, 
                        createLead: true 
                    });
                }
            }
            Logger.info('sync', `[SYNC] ${messages.length} mensagens processadas para ${sessionId}.`, { companyId, sessionId });
        }

    } catch (e) {
        Logger.error('sync', `[SYNC ERROR] Falha ao processar lote ${chunkCounter} para ${sessionId}`, { companyId, sessionId, error: e.message, stack: e.stack });
        if (isLatest) {
            await updateSyncStatus(sessionId, 'error', progress || 0);
        }
    } finally {
        if (progress !== undefined) {
             await updateSyncStatus(sessionId, 'importing_messages', progress);
        }
        if (isLatest) {
            await updateSyncStatus(sessionId, 'completed', 100);
            Logger.log('sync', `✅ [SYNC] Sincronização da sessão ${sessionId} finalizada.`);
        }
    }
};
