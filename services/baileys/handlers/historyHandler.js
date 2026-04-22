
import { upsertContactsBulk, updateSyncStatus, normalizeJid, upsertContact } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// [AJUSTE] Reduzido para 10 para permitir download seguro de mídia
const HISTORY_MSG_LIMIT = 10; 
const HISTORY_MONTHS_LIMIT = 8;
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
    const CONCURRENCY = 1; // 🛡️ Reduzido de 3 para 1. Evita flood e 'bad-request' na Meta
    const DELAY = 1500;    // 🛡️ Aumentado para 1.5s entre requisições
    
    (async () => {
        for (let i = 0; i < contacts.length; i += CONCURRENCY) {
            const chunk = contacts.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(async (c) => {
                try {
                    const newUrl = await sock.profilePictureUrl(c.jid, 'image').catch(() => null);
                    if (newUrl) {
                        await upsertContact(c.jid, companyId, null, newUrl, false, null, false, null, { profile_pic_updated_at: new Date() });
                    }
                } catch (e) {}
            }));
            await sleep(DELAY);
        }
    })();
};

// =============================================================================
// BARREIRA DE SINCRONIZAÇÃO — 3 FASES ESTRITAS (Manual Baileys §11.1)
//
// As fases são SEQUENCIAIS e não podem ser invertidas:
//   Fase 1 → lidPnMappings  : O Coração do CRM para grupos (LID ↔ PN)
//   Fase 2 → contacts       : Upsert massivo antes de qualquer mensagem
//   Fase 3 → chats/messages : Processado SOMENTE após Fase 2 concluída
//
// Isso garante que nenhuma chave estrangeira (contact_jid) seja violada.
// =============================================================================
export const handleHistorySync = async ({ contacts, messages, isLatest, progress, lidPnMappings }, sock, sessionId, companyId, chunkCounter) => {
    
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) return;
    processedHistoryChunks.add(chunkKey);

    const estimatedProgress = progress || Math.min(10 + (chunkCounter * 2), 95);
    console.log(`📚 [SYNC] Lote ${chunkCounter} | LID-PN Maps: ${lidPnMappings?.length || 0} | Contatos Brutos: ${contacts?.length || 0} | Msgs: ${messages?.length || 0}`);
    
    await updateSyncStatus(sessionId, 'importing_contacts', estimatedProgress);

    try {

        // =====================================================================
        // FASE 1: LID-PN MAPPING (Manual §11.1 — Prioridade Absoluta)
        //
        // O WhatsApp está migrando para LIDs (Logical IDs). Sem esse mapeamento
        // o CRM perde a identidade real (número de telefone) de contatos em grupos.
        //
        // Fontes de mapeamento (em ordem de confiabilidade):
        //   1. lidPnMappings nativos do evento (mais confiável, array separado)
        //   2. contacts que possuem o campo .lid embutido (complementar)
        // =====================================================================

        // Fonte 1: lidPnMappings nativos entregues pelo Baileys no evento
        if (lidPnMappings && lidPnMappings.length > 0) {
            console.log(`🗺️  [FASE 1] Processando ${lidPnMappings.length} mapeamentos LID-PN nativos...`);
            
            const lidBatch = lidPnMappings
                .filter(m => m.lid && m.pn)  // garante que ambos existem
                .map(m => ({
                    p_lid: normalizeJid(m.lid),
                    p_phone: normalizeJid(m.pn),
                    p_company_id: companyId
                }));

            // Processa em série para evitar sobrecarga de RPC no Supabase
            for (const mapping of lidBatch) {
                try {
                    const { error } = await supabase.rpc('link_identities', mapping);
                    if (error) throw error;
                } catch (e) {
                    // Falha individual não aborta o lote — apenas loga
                    console.warn(`⚠️  [FASE 1] Falha ao mapear LID ${mapping.p_lid}:`, e.message);
                }
            }
            console.log(`✅ [FASE 1] ${lidBatch.length} mapeamentos LID-PN nativos processados.`);
        }

        // Fonte 2: contacts que trazem .lid embutido (complementar ao lidPnMappings)
        // 🛡️ RESGATE AGRESSIVO: O Baileys pode enviar c.id como PN e c.lid como LID,
        // OU c.id como LID e c.lid como PN dependendo da versão do protocolo.
        // Testamos AMBOS os sentidos para garantir que identity_map seja populada.
        if (contacts && contacts.length > 0) {
            const contactsWithLid = contacts.filter(c => c.id && c.lid);
            if (contactsWithLid.length > 0) {
                console.log(`🗺️  [FASE 1] Processando ${contactsWithLid.length} mapeamentos LID embutidos (resgate duplo-sentido)...`);
                for (const c of contactsWithLid) {
                    try {
                        const idNorm  = normalizeJid(c.id);
                        const lidNorm = normalizeJid(c.lid);
                        if (!idNorm || !lidNorm) continue;

                        // Determina qual campo é o LID e qual é o número de telefone
                        // baseado no sufixo do JID (regra de negócio: @lid = LID, @s.whatsapp.net = PN)
                        let finalLid, finalPn;
                        if (idNorm.includes('@lid')) {
                            // Sentido A: c.id é o LID, c.lid é o número (menos comum)
                            finalLid = idNorm;
                            finalPn  = lidNorm;
                        } else {
                            // Sentido B (padrão): c.id é o número, c.lid é o LID
                            finalPn  = idNorm;
                            finalLid = lidNorm;
                        }

                        // Só persiste se o par faz sentido (PN deve ser @s.whatsapp.net)
                        if (finalPn.includes('@s.whatsapp.net') || finalPn.includes('@g.us')) {
                            const { error } = await supabase.rpc('link_identities', {
                                p_lid: finalLid,
                                p_phone: finalPn,
                                p_company_id: companyId
                            });
                            if (error) throw error;
                        }
                    } catch (e) {
                        console.warn(`⚠️  [FASE 1] Falha no LID embutido (${c.id}):`, e.message);
                    }
                }
                console.log(`✅ [FASE 1] ${contactsWithLid.length} mapeamentos LID embutidos processados.`);
            }
        }

        // =====================================================================
        // FASE 2: UPSERT MASSIVO DE CONTACTS (Manual §11.1)
        //
        // Todos os contacts devem estar no banco ANTES de qualquer mensagem
        // ser processada. Inclui dois sub-passos:
        //   2a. Normalização da agenda de contatos
        //   2b. Name Harvesting das mensagens (enriquece contatos sem nome)
        // =====================================================================

        const contactsMap = new Map();
        const contactsToFetchPic = [];

        // --- FASE 2a: NORMALIZAÇÃO DA AGENDA ---
        if (contacts && contacts.length > 0) {
            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                // status@broadcast é ignorado aqui
                if (!jid || jid === 'status@broadcast') continue;

                const phoneName = c.name || c.notify || c.verifiedName;
                const isFromBook = !!(c.name && c.name.trim().length > 0);

                contactsMap.set(jid, { 
                    jid,
                    name: phoneName, 
                    isFromBook: isFromBook,
                    imgUrl: c.imgUrl,
                    verifiedName: c.verifiedName
                });
            }
        }

        // --- FASE 2b: NAME HARVESTING (enriquece com pushName das mensagens) ---
        // Recupera nomes de contatos que NÃO estão na agenda mas aparecem nas mensagens
        if (messages && messages.length > 0) {
            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key) return;
                
                const remoteJid = normalizeJid(clean.key.remoteJid);
                const participant = clean.key.participant ? normalizeJid(clean.key.participant) : null;
                const targetJid = participant || remoteJid;

                if (targetJid && !targetJid.includes('status@broadcast') && clean.pushName) {
                    const existing = contactsMap.get(targetJid);
                    // Só usa pushName se não há nome vindo da agenda física do telefone
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

        // --- PERSISTÊNCIA DA FASE 2 (Upsert Massivo) ---
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
            console.log(`👥 [FASE 2] Persistindo ${bulkPayload.length} contatos no CRM...`);
            const BATCH_SIZE = 500;
            for (let i = 0; i < bulkPayload.length; i += BATCH_SIZE) {
                await upsertContactsBulk(bulkPayload.slice(i, i + BATCH_SIZE));
            }
            console.log(`✅ [FASE 2] Contatos persistidos. FK garantida para mensagens.`);
        }
            
        // Fotos de perfil: dispara em background APÓS o upsert (não bloqueia a Fase 3)
        if (contactsToFetchPic.length > 0) {
            fetchProfilePicsInBackground(sock, contactsToFetchPic, companyId);
        }

        // =====================================================================
        // FASE 3: CHATS E MENSAGENS (Manual §11.1 — Só após Fase 2)
        //
        // Executada SOMENTE após os contacts estarem no banco.
        // Isso garante que a FK (contact_jid → contacts.jid) nunca seja violada.
        // =====================================================================

        if (messages && messages.length > 0) {
            await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress + 2);
            
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // 🛡️ [LID RESOLVER LOCAL] Mapa de resolução construído a partir dos dados
            // já em memória das Fases 1 e 2 — zero custo de rede adicional.
            // Garante que mensagens históricas sejam agrupadas sob o phone JID canônico
            // desde o início, evitando split de conversa com mensagens em tempo real.
            const localLidMap = new Map();
            if (lidPnMappings && lidPnMappings.length > 0) {
                for (const m of lidPnMappings) {
                    if (m.lid && m.pn) {
                        const normLid = normalizeJid(m.lid);
                        const normPn  = normalizeJid(m.pn);
                        if (normLid && normPn) localLidMap.set(normLid, normPn);
                    }
                }
            }
            // Complementa com contacts que trazem .lid embutido (duplo-sentido)
            if (contacts && contacts.length > 0) {
                for (const c of contacts) {
                    if (!c.id || !c.lid) continue;
                    const idNorm  = normalizeJid(c.id);
                    const lidNorm = normalizeJid(c.lid);
                    if (!idNorm || !lidNorm) continue;
                    if (idNorm.includes('@lid'))  localLidMap.set(idNorm,  lidNorm);
                    else if (lidNorm.includes('@lid')) localLidMap.set(lidNorm, idNorm);
                }
            }
            if (localLidMap.size > 0) {
                console.log(`🗺️  [FASE 3] LID Map local pronto: ${localLidMap.size} mapeamentos em memória.`);
            }

            const chats = {}; 
            
            messages.forEach(msg => {
                let clean;
                try { clean = unwrapMessage(msg); } catch(e) { return; } 

                if (!clean.key?.remoteJid) return;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return;

                let jid = normalizeJid(clean.key.remoteJid);
                if (!jid || jid === 'status@broadcast') return;

                // 🛡️ [LID RESOLVER] Resolve @lid → phone JID usando o mapa local (sem query)
                if (jid.includes('@lid') && localLidMap.has(jid)) {
                    jid = localLidMap.get(jid);
                }

                if (!chats[jid]) chats[jid] = [];
                
                // Injeta nome resolvido — contactsMap já populado pela Fase 2, acesso seguro
                // Testa tanto o jid resolvido quanto o original (fallback)
                const knownContact = contactsMap.get(jid) || contactsMap.get(normalizeJid(clean.key.remoteJid));
                clean._forcedName = knownContact?.isFromBook 
                    ? knownContact.name 
                    : (knownContact?.name || clean.pushName);
                
                chats[jid].push(clean);
            });

            let chatJids = Object.keys(chats);
            console.log(`💬 [FASE 3] Processando ${chatJids.length} chats e suas mensagens...`);

            // [NOVO] Limite de 200 conversas, priorizando as mais recentes
            const HISTORY_CHAT_LIMIT = 200;
            if (chatJids.length > HISTORY_CHAT_LIMIT) {
                chatJids.sort((a, b) => {
                    const topA = chats[a].reduce((max, msg) => Math.max(max, Number(msg.messageTimestamp) || 0), 0);
                    const topB = chats[b].reduce((max, msg) => Math.max(max, Number(msg.messageTimestamp) || 0), 0);
                    return topB - topA; // Decrescente (mais recente primeiro)
                });
                chatJids = chatJids.slice(0, HISTORY_CHAT_LIMIT);
                console.log(`💬 [FASE 3] Limitado a ${HISTORY_CHAT_LIMIT} conversas mais recentes.`);
            }

            for (const jid of chatJids) {
                chats[jid].sort((a, b) => (Number(a.messageTimestamp) || 0) - (Number(b.messageTimestamp) || 0)); 
                const topMessages = chats[jid].slice(-HISTORY_MSG_LIMIT);
                
                const latestMsg = topMessages[topMessages.length - 1];
                if (latestMsg && latestMsg.messageTimestamp) {
                    const ts = new Date(Number(latestMsg.messageTimestamp) * 1000);
                    // Fire-and-forget: atualiza last_message_at sem bloquear o loop
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
                    } catch (msgError) {
                        // Falha individual de mensagem não aborta o lote do chat
                        console.warn(`⚠️  [FASE 3] Falha ao processar msg do chat ${jid}:`, msgError.message);
                    }
                }
                // [OTIMIZAÇÃO] Delay entre chats para dar tempo ao download de mídia
                await sleep(50); 
            }
            console.log(`✅ [FASE 3] Chats e mensagens processados.`);
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR] Falha crítica na Barreira de Sincronização:", e);
    } finally {
        if (isLatest) {
            console.log(`✅ [HISTÓRICO] Sincronização Total Concluída. Todas as 3 fases executadas.`);
            await updateSyncStatus(sessionId, 'completed', 100);
            resetHistoryState(sessionId);
        }
    }
};
