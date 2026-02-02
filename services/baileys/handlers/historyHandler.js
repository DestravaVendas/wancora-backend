
import { upsertContact, updateSyncStatus } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage, normalizeJid } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CONFIGURAÇÕES
const MSG_LIMIT_PER_CHAT = 15; // Aumentado levemente
const HISTORY_MONTHS_LIMIT = 6;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const handleHistorySync = async ({ contacts, messages, isLatest }, sock, sessionId, companyId, chunkCounter) => {
    
    // Feedback visual (apenas para atualizar o banco que estamos vivos)
    // O frontend vai ignorar isso se estiver na fase "Preparando"
    if (chunkCounter > 2) {
        await updateSyncStatus(sessionId, 'importing_messages', 50);
    } else {
        await updateSyncStatus(sessionId, 'importing_contacts', 10);
    }

    console.log(`📚 [SYNC] Processando Lote #${chunkCounter} | Latest: ${isLatest}`);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // 1. CONTATOS (Prioridade Absoluta)
        // -----------------------------------------------------------
        // Processa TODOS os contatos do lote ANTES de qualquer mensagem
        if (contacts && contacts.length > 0) {
            console.log(`👤 [SYNC Lote ${chunkCounter}] Salvando ${contacts.length} contatos...`);
            
            const BATCH_SIZE = 50;
            for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
                const batch = contacts.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    const bestName = c.name || c.verifiedName || c.notify;
                    
                    // Só busca foto se realmente necessário (otimização)
                    let finalImgUrl = c.imgUrl || null;
                    if (!finalImgUrl && chunkCounter <= 2) { 
                        // Prioriza fotos apenas nos primeiros lotes para velocidade
                        try { finalImgUrl = await sock.profilePictureUrl(jid, 'image'); } catch (e) {}
                    }

                    contactsMap.set(jid, { name: bestName });
                    await upsertContact(jid, companyId, bestName, finalImgUrl, !!c.name, c.lid);
                }));
            }
        }

        // --- PAUSA ESTRATÉGICA ---
        // Dá 500ms para o banco indexar os contatos antes de inserir as mensagens
        // Isso resolve o problema de "Sem Nome" nos leads criados pelas mensagens
        await sleep(500);


        // -----------------------------------------------------------
        // 2. MENSAGENS DO LOTE (Processamento Imediato)
        // -----------------------------------------------------------
        let messagesToProcess = [];
        
        if (messages && messages.length > 0) {
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Filtragem básica
            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) return;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return;

                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') return;

                // Tenta injetar nome do contato que acabamos de salvar
                const known = contactsMap.get(jid);
                if(known) clean._forcedName = known.name;
                else if (clean.pushName) clean._forcedName = clean.pushName;
                
                messagesToProcess.push(clean);
            });
        }

        // Processamento Linear do Lote
        const total = messagesToProcess.length;
        if (total > 0) {
            let processed = 0;
            // Intervalo de log menor para feedback rápido no terminal
            const logInterval = Math.max(Math.floor(total * 0.1), 10); 

            // Processa mensagens mais recentes primeiro (reverse do array que vem do WA)
            // O WhatsApp manda do mais antigo pro mais novo no array
            // Mas queremos garantir que a última msg atualize o contato por ultimo
            // Então processamos na ordem normal de chegada
            
            for (const msg of messagesToProcess) {
                try {
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, { 
                        downloadMedia: true, 
                        createLead: true 
                    });
                    
                    processed++;

                    if (processed % logInterval === 0 || processed === total) {
                        const percent = Math.floor((processed / total) * 100);
                        // Log local do lote
                        console.log(`⏳ [SYNC Lote ${chunkCounter}] ${processed}/${total} mensagens (${percent}%)`);
                        
                        // Atualiza percentual no banco (Para o frontend pegar se já passou a fase de prep)
                        if (chunkCounter > 2) {
                             await updateSyncStatus(sessionId, 'importing_messages', percent);
                        }
                    }
                } catch (err) {
                    // Continua
                }
                // Throttle mínimo
                if (processed % 20 === 0) await sleep(5);
            }
        }

    } catch (e) {
        console.error("❌ [SYNC FATAL]", e);
    } finally {
        // -----------------------------------------------------------
        // 3. FINALIZAÇÃO (Se for o último lote)
        // -----------------------------------------------------------
        if (isLatest) {
            console.log(`✅ [SYNC FINAL] Histórico 100% concluído.`);
            await sleep(2000); // Garante que tudo foi salvo
            
            // Força fechamento do modal no frontend
            await updateSyncStatus(sessionId, 'completed', 100);
        }
    }
};
