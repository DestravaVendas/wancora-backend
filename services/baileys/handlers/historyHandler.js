
import { upsertContact, updateSyncStatus } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage, normalizeJid } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CONFIGURAÇÕES DE LIMITE
const MSG_LIMIT_PER_CHAT = 10; // 10 msgs mais recentes
const CHAT_LIMIT = 200; // 200 conversas mais ativas
const HISTORY_MONTHS_LIMIT = 8; // 8 meses

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const handleHistorySync = async ({ contacts, messages, isLatest }, sock, sessionId, companyId) => {
    
    // Se já completou, ignora (Idempotência básica)
    const { data: currentInstance } = await supabase.from('instances')
        .select('sync_status')
        .eq('session_id', sessionId)
        .single();
        
    if (currentInstance?.sync_status === 'completed') return;

    console.log(`📚 [HISTÓRICO] Iniciando processamento...`);
    await updateSyncStatus(sessionId, 'importing_contacts', 5);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // 1. CONTATOS (Processamento Rápido)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            // Processa em paralelo para velocidade
            await Promise.all(contacts.map(async (c) => {
                const jid = normalizeJid(c.id);
                if (!jid) return;
                
                const bestName = c.name || c.verifiedName || c.notify;
                
                // Tenta pegar foto se não tiver
                let finalImgUrl = c.imgUrl || null;
                if (!finalImgUrl) {
                    try { finalImgUrl = await sock.profilePictureUrl(jid, 'image'); } catch (e) {}
                }

                contactsMap.set(jid, { name: bestName });
                // Upsert Fire & Forget
                upsertContact(jid, companyId, bestName, finalImgUrl, !!c.name, c.lid);
            }));
            await sleep(50); // Pausa para garantir gravação
        }

        // -----------------------------------------------------------
        // 2. FILTRAGEM & CONTAGEM (PREPARAÇÃO)
        // -----------------------------------------------------------
        let messagesToProcess = [];
        
        if (messages && messages.length > 0) {
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Agrupa por chat
            const chats = {}; 
            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) return;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return; // Ignora muito antigos

                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') return;

                if (!chats[jid]) chats[jid] = [];
                // Injeta nome forçado se descobrimos nos contatos
                const known = contactsMap.get(jid);
                if(known) clean._forcedName = known.name;
                
                chats[jid].push(clean);
            });

            // Ordena chats por atividade recente
            const sortedChatJids = Object.keys(chats).sort((a, b) => {
                const lastA = chats[a][chats[a].length - 1]?.messageTimestamp || 0;
                const lastB = chats[b][chats[b].length - 1]?.messageTimestamp || 0;
                return lastB - lastA;
            });

            // Aplica limite de 200 chats
            const targetJids = sortedChatJids.slice(0, CHAT_LIMIT);
            
            // Prepara lista final de mensagens (Flat)
            for (const jid of targetJids) {
                // Ordena mensagens dentro do chat
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
                
                // Atualiza last_message_at do contato
                const latest = chats[jid][0]; // Como ordenamos desc, o 0 é o mais recente
                if (latest) {
                    const ts = new Date(Number(latest.messageTimestamp) * 1000);
                    supabase.from('contacts').update({ last_message_at: ts }).eq('company_id', companyId).eq('jid', jid).then();
                }

                // Pega as TOP N mensagens
                const msgs = chats[jid].slice(0, MSG_LIMIT_PER_CHAT);
                // Reverte para ordem cronológica (antiga -> nova) para inserção correta
                msgs.reverse();
                
                messagesToProcess.push(...msgs);
            }
        }

        // -----------------------------------------------------------
        // 3. PROCESSAMENTO LINEAR COM LOGS (2 em 2%)
        // -----------------------------------------------------------
        const total = messagesToProcess.length;
        console.log(`📥 [SYNC] Total Filtrado: ${total} mensagens para importar.`);
        
        if (total > 0) {
            let processed = 0;
            // Intervalo de log: a cada 2% ou a cada 10 msgs (o que for maior)
            const logInterval = Math.max(Math.floor(total * 0.02), 10); 

            for (const msg of messagesToProcess) {
                try {
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, { 
                        downloadMedia: true, 
                        createLead: true 
                    });
                    
                    processed++;

                    // LOG & DB UPDATE
                    if (processed % logInterval === 0 || processed === total) {
                        const percent = Math.floor((processed / total) * 100);
                        
                        // Log no console como pedido
                        console.log(`⏳ [SYNC PROGRESS] ${processed}/${total} mensagens (${percent}%)`);
                        
                        // Atualiza banco para a barra do frontend andar (trava em 99 se não for latest)
                        const visualPercent = (percent === 100 && !isLatest) ? 99 : percent;
                        await updateSyncStatus(sessionId, 'importing_messages', visualPercent);
                    }
                } catch (err) {
                    // Continua mesmo com erro
                }
                
                // Throttle minúsculo para não travar event loop
                if (processed % 50 === 0) await sleep(50);
            }
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        // -----------------------------------------------------------
        // 4. CONCLUSÃO (FORÇA 100%)
        // -----------------------------------------------------------
        if (isLatest) {
            console.log(`✅ [SYNC FINAL] Histórico 100% concluído.`);
            await sleep(1000); // Pequeno delay pra UI respirar
            
            // AQUI ESTÁ O SEGREDO: Manda 100 e completed. O Frontend vai pegar e fechar.
            await updateSyncStatus(sessionId, 'completed', 100);
            processedHistoryChunks.clear();
        }
    }
};
