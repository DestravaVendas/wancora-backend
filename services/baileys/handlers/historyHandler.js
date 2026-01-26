
import { upsertContact, updateSyncStatus, normalizeJid } from '../../crm/sync.js';
import { handleMessage, unwrapMessage } from './messageHandler.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export const handleHistorySync = async ({ contacts, messages, isLatest }, sock, sessionId, companyId, chunkCounter) => {
    
    // Verifica se já completou para evitar reprocessamento desnecessário
    const { data: currentInstance } = await supabase.from('instances')
        .select('sync_status')
        .eq('session_id', sessionId)
        .eq('company_id', companyId)
        .single();
        
    if (currentInstance?.sync_status === 'completed') {
        return;
    }

    if (chunkCounter > 1) {
        console.log(`⏩ [HISTÓRICO] Ignorando lote extra ${chunkCounter} para otimização.`);
        await updateSyncStatus(sessionId, 'completed', 100);
        return;
    }

    console.log(`📚 [HISTÓRICO] Processando Lote Único...`);

    try {
        const contactsMap = new Map();

        // 1. Processar Contatos (Batch)
        if (contacts && contacts.length > 0) {
            await updateSyncStatus(sessionId, 'importing_contacts', 5);
            
            contacts.forEach(c => {
                const jid = normalizeJid(c.id);
                if (!jid) return;
                contactsMap.set(jid, { 
                    name: c.name || c.verifiedName || c.notify, 
                    imgUrl: c.imgUrl, 
                    isFromBook: !!c.name, 
                    lid: c.lid || null 
                });
            });

            // Upsert em lotes de 10 para não travar o banco
            const uniqueJids = Array.from(contactsMap.keys());
            const BATCH_SIZE = 10;
            
            for (let i = 0; i < uniqueJids.length; i += BATCH_SIZE) {
                const batchJids = uniqueJids.slice(i, i + BATCH_SIZE);
                await Promise.all(batchJids.map(async (jid) => {
                    let data = contactsMap.get(jid);
                    // Lógica segura de enriquecimento (Group Subject / Profile Pic) seria feita aqui
                    // Mas para histórico, confiamos nos dados que vieram no payload para performance
                    await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook, data.lid);
                }));
                await new Promise(r => setTimeout(r, 20)); // Respiro
            }
        }

        // 2. Processar Mensagens (Granular)
        if (messages && messages.length > 0) {
            // Name Hunter Pre-Pass
            messages.forEach(msg => {
                if (msg.key.fromMe) return;
                const jid = normalizeJid(msg.key.remoteJid);
                if (!jid) return;
                const existing = contactsMap.get(jid);
                // Se descobrimos um nome novo no pushName da mensagem, salvamos
                if ((!existing || !existing.name) && msg.pushName) {
                    upsertContact(jid, companyId, msg.pushName, null, false);
                }
            });

            // Flatten & Sort & Limit
            let allMessages = [];
            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if(clean.key?.remoteJid && normalizeJid(clean.key.remoteJid) !== 'status@broadcast') {
                    // Injeta nome forçado do mapa se existir
                    const mapData = contactsMap.get(normalizeJid(clean.key.remoteJid));
                    clean._forcedName = clean.pushName || (mapData ? mapData.name : null);
                    allMessages.push(clean);
                }
            });

            // Ordena cronologicamente
            allMessages.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
            
            // Opcional: Limitar histórico (ex: últimas 500 globais ou 20 por chat)
            // Aqui processaremos todas que vieram no chunk principal
            
            const total = allMessages.length;
            let processed = 0;
            let lastLoggedPercent = 0;

            console.log(`📥 [SYNC] Importando ${total} mensagens...`);
            await updateSyncStatus(sessionId, 'importing_messages', 10);

            for (const msg of allMessages) {
                // Reutiliza a lógica central de mensagem
                await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName);
                processed++;

                const percent = Math.min(99, Math.floor((processed / total) * 100));
                if (percent >= lastLoggedPercent + 5) {
                    await updateSyncStatus(sessionId, 'importing_messages', percent);
                    lastLoggedPercent = percent;
                }
                
                if (processed % 20 === 0) await new Promise(r => setTimeout(r, 10)); // Anti-block
            }
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        await updateSyncStatus(sessionId, 'completed', 100);
        console.log(`✅ [HISTÓRICO] Sincronização Finalizada.`);
    }
};
