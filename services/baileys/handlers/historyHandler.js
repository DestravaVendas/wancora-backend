
import { upsertContact, updateSyncStatus } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage, normalizeJid } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CONFIGURAÇÕES
const MSG_LIMIT_PER_CHAT = 20; // Aumentado para pegar mais contexto
const HISTORY_MONTHS_LIMIT = 6;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const handleHistorySync = async ({ contacts, messages, isLatest }, sock, sessionId, companyId, chunkCounter) => {
    
    // LOG & FEEDBACK INICIAL
    console.log(`📚 [SYNC] Lote #${chunkCounter} recebido. Contatos: ${contacts?.length || 0}, Msgs: ${messages?.length || 0}`);
    
    // Se tiver mensagens, já avisa que estamos na fase de mensagens (destrava o frontend)
    // Se não tiver, mantém em contatos.
    const currentStatus = (messages && messages.length > 0) ? 'importing_messages' : 'importing_contacts';
    
    // Atualiza status imediatamente para o frontend reagir
    await updateSyncStatus(sessionId, currentStatus, 5);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // 1. CONTATOS (Prioridade Absoluta)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            
            const BATCH_SIZE = 50;
            for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                const batch = contacts.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    const bestName = c.name || c.verifiedName || c.notify;
                    
                    // Busca foto apenas nos primeiros lotes para não gargalar
                    let finalImgUrl = c.imgUrl || null;
                    if (!finalImgUrl && chunkCounter <= 1) { 
                        try { finalImgUrl = await sock.profilePictureUrl(jid, 'image'); } catch (e) {}
                    }

                    contactsMap.set(jid, { name: bestName });
                    await upsertContact(jid, companyId, bestName, finalImgUrl, !!c.name, c.lid);
                }));
            }
        }

        // Delay tático para o banco absorver os contatos antes das mensagens
        await sleep(200); 

        // -----------------------------------------------------------
        // 2. MENSAGENS DO LOTE (Processamento Imediato)
        // -----------------------------------------------------------
        let messagesToProcess = [];
        
        if (messages && messages.length > 0) {
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) return;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return;

                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') return;

                // Injeta nome conhecido para facilitar criação do Lead
                const known = contactsMap.get(jid);
                if(known) clean._forcedName = known.name;
                else if (clean.pushName) clean._forcedName = clean.pushName;
                
                messagesToProcess.push(clean);
            });
        }

        const total = messagesToProcess.length;
        
        if (total > 0) {
            // Se vamos processar mensagens, garanta que o status no banco é esse
            await updateSyncStatus(sessionId, 'importing_messages', 10);

            let processed = 0;
            // Log a cada 10% ou mínimo 10 mensagens
            const logInterval = Math.max(Math.floor(total * 0.1), 10); 

            for (const msg of messagesToProcess) {
                try {
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, { 
                        downloadMedia: true, 
                        createLead: true 
                    });
                    
                    processed++;

                    if (processed % logInterval === 0 || processed === total) {
                        const percent = Math.floor((processed / total) * 100);
                        
                        console.log(`⏳ [SYNC Lote ${chunkCounter}] ${processed}/${total} (${percent}%)`);
                        
                        // Atualiza a barra real no frontend
                        await updateSyncStatus(sessionId, 'importing_messages', percent);
                    }
                } catch (err) {
                    // Ignora erro individual
                }
                // Throttle leve
                if (processed % 50 === 0) await sleep(50);
            }
        }

    } catch (e) {
        console.error("❌ [SYNC FATAL]", e);
    } finally {
        // -----------------------------------------------------------
        // 3. FINALIZAÇÃO
        // -----------------------------------------------------------
        if (isLatest) {
            console.log(`✅ [SYNC FINAL] Histórico 100% concluído.`);
            await sleep(1000); 
            
            // Força fechamento
            await updateSyncStatus(sessionId, 'completed', 100);
        }
    }
};
