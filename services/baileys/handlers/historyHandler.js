
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
export const handleHistorySync = async ({ contacts, messages, isLatest, progress, lidPnMappings, labels, labelAssociations }, sock, sessionId, companyId, chunkCounter) => {
    
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) return;
    processedHistoryChunks.add(chunkKey);

    const estimatedProgress = progress || Math.min(10 + (chunkCounter * 2), 95);
    console.log(`📚 [SYNC] Lote ${chunkCounter} | LID-PN Maps: ${lidPnMappings?.length || 0} | Contatos Brutos: ${contacts?.length || 0} | Msgs: ${messages?.length || 0} | Labels: ${labels?.length || 0} | Label Assocs: ${labelAssociations?.length || 0}`);
    
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
        // Fonte 1: lidPnMappings nativos entregues pelo Baileys no evento (Bulk Upsert)
        if (lidPnMappings && lidPnMappings.length > 0) {
            console.log(`🗺️  [FASE 1] Processando ${lidPnMappings.length} mapeamentos LID-PN nativos (Bulk Upsert)...`);
            
            const lidBatch = lidPnMappings
                .filter(m => m.lid && m.pn)  // garante que ambos existem
                .map(m => ({
                    lid_jid: normalizeJid(m.lid),
                    phone_jid: normalizeJid(m.pn),
                    company_id: companyId
                }));

            if (lidBatch.length > 0) {
                try {
                    const { error } = await supabase
                        .from('identity_map')
                        .upsert(lidBatch, { onConflict: 'lid_jid, company_id' });
                    if (error) throw error;
                    console.log(`✅ [FASE 1] ${lidBatch.length} mapeamentos LID-PN nativos processados via Bulk.`);
                } catch (e) {
                    console.error(`❌ [FASE 1] Falha no Bulk Upsert LID-PN nativos:`, e.message);
                }
            }
        }

        // Fonte 2: contacts que trazem .lid embutido (complementar ao lidPnMappings - Bulk Upsert)
        if (contacts && contacts.length > 0) {
            const contactsWithLid = contacts.filter(c => c.id && c.lid);
            if (contactsWithLid.length > 0) {
                console.log(`🗺️  [FASE 1] Processando ${contactsWithLid.length} mapeamentos LID embutidos (Bulk Upsert)...`);
                
                const lidBatch = [];
                for (const c of contactsWithLid) {
                    const idNorm  = normalizeJid(c.id);
                    const lidNorm = normalizeJid(c.lid);
                    if (!idNorm || !lidNorm) continue;

                    let finalLid, finalPn;
                    if (idNorm.includes('@lid')) {
                        finalLid = idNorm;
                        finalPn  = lidNorm;
                    } else {
                        finalPn  = idNorm;
                        finalLid = lidNorm;
                    }

                    if (finalPn.includes('@s.whatsapp.net') || finalPn.includes('@g.us')) {
                        lidBatch.push({
                            lid_jid: finalLid,
                            phone_jid: finalPn,
                            company_id: companyId
                        });
                    }
                }

                if (lidBatch.length > 0) {
                    try {
                        const { error } = await supabase
                            .from('identity_map')
                            .upsert(lidBatch, { onConflict: 'lid_jid, company_id' });
                        if (error) throw error;
                        console.log(`✅ [FASE 1] ${lidBatch.length} mapeamentos LID embutidos processados via Bulk.`);
                    } catch (e) {
                        console.error(`❌ [FASE 1] Falha no Bulk Upsert LID embutidos:`, e.message);
                    }
                }
            }
        }

        // =====================================================================
        // FASE 1.5: LABELS E ASSOCIAÇÕES (WhatsApp Business)
        // =====================================================================
        if (labels && labels.length > 0) {
            console.log(`🏷️  [FASE 1.5] Sincronizando ${labels.length} Etiquetas...`);
            const labelBatch = labels.map(lbl => ({
                company_id: companyId,
                label_id: lbl.id,
                name: lbl.name,
                color: lbl.color,
                updated_at: new Date()
            }));
            try {
                await supabase.from('wa_labels').upsert(labelBatch, { onConflict: 'company_id, label_id' });
            } catch (e) {
                console.error("❌ Erro ao sincronizar Etiquetas:", e.message);
            }
        }

        if (labelAssociations && labelAssociations.length > 0) {
            console.log(`🏷️  [FASE 1.5] Sincronizando ${labelAssociations.length} Associações de Etiquetas...`);
            
            // Agrupar as associações por chat (JID)
            const chatLabels = new Map();
            for (const assoc of labelAssociations) {
                if (assoc.type === 'chat' && assoc.chatId && assoc.labelId) {
                    const jid = normalizeJid(assoc.chatId);
                    if (!chatLabels.has(jid)) chatLabels.set(jid, new Set());
                    chatLabels.get(jid).add(assoc.labelId);
                }
            }

            for (const [jid, labelSet] of chatLabels.entries()) {
                try {
                    const { data } = await supabase.from('contacts').select('wa_labels').eq('jid', jid).eq('company_id', companyId).maybeSingle();
                    let currentLabels = data?.wa_labels || [];
                    let changed = false;
                    for (const lbl of labelSet) {
                        if (!currentLabels.includes(lbl)) {
                            currentLabels.push(lbl);
                            changed = true;
                        }
                    }
                    if (changed) {
                        await supabase.from('contacts').update({ wa_labels: currentLabels }).eq('jid', jid).eq('company_id', companyId);
                    }
                } catch (e) {
                    console.error("❌ Erro ao associar etiqueta ao contato:", jid, e.message);
                }
            }
        }

        // =====================================================================
        // FASE 2: IMPORTAÇÃO DE CONTATOS (Agenda e PushNames)
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
        
        // 🛡️ SILENT SYNC: Consulta contatos existentes para evitar sobrescrever status de triagem
        const jidsArray = Array.from(contactsMap.keys());
        const BATCH_QUERY = 500;
        const currentIgnoredMap = new Map();
        
        for (let i = 0; i < jidsArray.length; i += BATCH_QUERY) {
             const chunk = jidsArray.slice(i, i + BATCH_QUERY);
             try {
                 const { data: dbContacts } = await supabase.from('contacts')
                     .select('jid, is_ignored')
                     .eq('company_id', companyId)
                     .in('jid', chunk);
                 if (dbContacts) {
                     dbContacts.forEach(c => currentIgnoredMap.set(c.jid, c.is_ignored));
                 }
             } catch (err) {
                 console.error("❌ Erro ao consultar is_ignored:", err.message);
             }
        }
        
        for (const [jid, data] of contactsMap.entries()) {
             const isRealPhone = jid.includes('@s.whatsapp.net');
             const purePhone = isRealPhone ? jid.split('@')[0].replace(/\D/g, '') : null; 
             const contactData = {
                jid: jid,
                company_id: companyId,
                updated_at: new Date()
            };
            if (purePhone) contactData.phone = purePhone;

            // SILENT SYNC: Se não existia no banco, inicia como ignorado para não poluir o ChatList (exceto grupos)
            if (currentIgnoredMap.get(jid) === undefined) {
                 if (jid.includes('@g.us')) {
                     contactData.is_ignored = false;
                 } else {
                     contactData.is_ignored = true;
                 }
            }

            if (data.isFromBook) {
                contactData.name = data.name;
            } else if (data.name) {
                contactData.push_name = data.name;
                contactData.name = data.name; // Prioriza push_name para não deixar nulo
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
        // FASE 3: CHATS E MENSAGENS (DESATIVADO)
        // 
        // [AMPUTADO CIRURGICAMENTE POR SOLICITAÇÃO DO USUÁRIO]
        // Mensagens históricas não são mais baixadas nem processadas para
        // acelerar absurdamente o login e impedir banimentos/quedas de rede (fetch failed/ETIMEDOUT).
        // Apenas atualizamos a barrinha visual de sincronização.
        // =====================================================================

        if (messages && messages.length > 0) {
            await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress + 2);
            // Nenhum processamento de mensagens. O novo fluxo é Realtime (Apenas Novas Mensagens).
            console.log(`💬 [FASE 3] Amputado: Ignorando ${messages.length} mensagens históricas a pedido do usuário.`);
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
