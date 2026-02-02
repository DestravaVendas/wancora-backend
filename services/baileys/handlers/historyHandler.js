
import { upsertContact, updateSyncStatus } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage, normalizeJid } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CONFIGURAÇÕES
const MSG_LIMIT_PER_CHAT = 10; 
const CHAT_LIMIT = 200; 
const HISTORY_MONTHS_LIMIT = 8;
const BUFFER_WAIT_TIME_MS = 15000; // 15 Segundos exatos

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// BUFFERS GLOBAIS (Memória Volátil do Processo)
let globalContactsBuffer = [];
let globalMessagesBuffer = [];
let isProcessing = false;

export const handleHistorySync = async ({ contacts, messages, isLatest }, sock, sessionId, companyId) => {
    
    // 1. Acumula no Buffer
    if (contacts) globalContactsBuffer.push(...contacts);
    if (messages) globalMessagesBuffer.push(...messages);

    // Feedback visual inicial (Ativa a barra de 'Preparando' no frontend)
    // O Frontend vai rodar a animação de 0 a 99% por 12s enquanto estamos aqui esperando
    await updateSyncStatus(sessionId, 'importing_contacts', 1);

    // 2. Se não for o último, só acumula e retorna
    if (!isLatest) return;

    // 3. Se já estiver processando (concorrência), ignora
    if (isProcessing) return;
    isProcessing = true;

    try {
        console.log(`⏳ [SYNC] Aguardando ${BUFFER_WAIT_TIME_MS / 1000}s para estabilizar nomes...`);
        // Aqui o frontend está rodando a animação de "Preparando..."
        await sleep(BUFFER_WAIT_TIME_MS);

        console.log(`🚀 [SYNC] Iniciando processamento UNIFICADO.`);
        
        // --- PROCESSAMENTO DE CONTATOS (Para garantir nomes) ---
        if (globalContactsBuffer.length > 0) {
            const uniqueContacts = new Map();
            // Inverte para que os mais recentes sobrescrevam (se houver duplicatas no buffer)
            globalContactsBuffer.forEach(c => uniqueContacts.set(c.id, c));
            
            const contactsList = Array.from(uniqueContacts.values());
            console.log(`👤 [SYNC] Salvando ${contactsList.length} contatos...`);

            const BATCH_SIZE = 50;
            for (let i = 0; i < contactsList.length; i += BATCH_SIZE) {
                const batch = contactsList.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (c) => {
                    const jid = normalizeJid(c.id);
                    if (!jid) return;
                    
                    const bestName = c.name || c.verifiedName || c.notify;
                    let finalImgUrl = c.imgUrl || null;
                    
                    // Tenta buscar foto se não tiver (sem travar)
                    if (!finalImgUrl) {
                        try { finalImgUrl = await sock.profilePictureUrl(jid, 'image'); } catch (e) {}
                    }

                    await upsertContact(jid, companyId, bestName, finalImgUrl, !!c.name, c.lid);
                }));
                // Pausa para DB respirar
                await sleep(10); 
            }
        }

        // --- FILTRAGEM & PREPARAÇÃO DE MENSAGENS ---
        let messagesToProcess = [];
        if (globalMessagesBuffer.length > 0) {
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Agrupa
            const chats = {};
            globalMessagesBuffer.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) return;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return;

                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') return;

                if (!chats[jid]) chats[jid] = [];
                if (clean.pushName) clean._forcedName = clean.pushName;
                
                chats[jid].push(clean);
            });

            const sortedChatJids = Object.keys(chats).sort((a, b) => {
                const lastA = chats[a][chats[a].length - 1]?.messageTimestamp || 0;
                const lastB = chats[b][chats[b].length - 1]?.messageTimestamp || 0;
                return lastB - lastA;
            });

            const targetJids = sortedChatJids.slice(0, CHAT_LIMIT);
            
            for (const jid of targetJids) {
                // Ordena mensagens do chat (mais recente por ultimo no array de processamento)
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
                
                // Atualiza last_message_at
                const latest = chats[jid][0];
                if (latest) {
                    const ts = new Date(Number(latest.messageTimestamp) * 1000);
                    supabase.from('contacts').update({ last_message_at: ts }).eq('company_id', companyId).eq('jid', jid).then();
                }

                const msgs = chats[jid].slice(0, MSG_LIMIT_PER_CHAT);
                msgs.reverse(); // Cronológico para inserção correta (Antiga -> Nova)
                messagesToProcess.push(...msgs);
            }
        }

        // --- PROCESSAMENTO DE MENSAGENS (COM LOGS DE PORCENTAGEM) ---
        const total = messagesToProcess.length;
        console.log(`📥 [SYNC] Total Final Filtrado: ${total} mensagens para importar.`);
        
        // Zera a barra no frontend para começar o progresso real
        await updateSyncStatus(sessionId, 'importing_messages', 0);

        if (total > 0) {
            let processed = 0;
            // Intervalo de log: a cada ~2% (mínimo 5 msgs)
            const logInterval = Math.max(Math.ceil(total * 0.02), 5); 

            for (const msg of messagesToProcess) {
                try {
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, { 
                        downloadMedia: true, 
                        createLead: true 
                    });
                    
                    processed++;

                    // LOG & DB UPDATE (2% em 2%)
                    if (processed % logInterval === 0 || processed === total) {
                        const percent = Math.floor((processed / total) * 100);
                        
                        console.log(`⏳ [SYNC PROGRESS] ${processed}/${total} mensagens (${percent}%)`);
                        
                        // Atualiza banco para a barra do frontend andar
                        await updateSyncStatus(sessionId, 'importing_messages', percent);
                    }
                } catch (err) {
                    console.error("Msg error", err);
                }
                
                // Pequeno delay para garantir gravação sequencial e "slow download" saudável
                await sleep(2);
            }
        }

        console.log(`✅ [SYNC] Concluído 100%. Limpando buffers.`);
        
        // 5. FINALIZAÇÃO FORÇADA
        globalContactsBuffer = [];
        globalMessagesBuffer = [];
        
        // Força 100% e Completed para fechar o modal
        await updateSyncStatus(sessionId, 'completed', 100);

    } catch (e) {
        console.error("❌ [SYNC FATAL]", e);
    } finally {
        isProcessing = false;
    }
};
