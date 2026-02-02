
import { upsertContact, updateSyncStatus } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage, normalizeJid } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CONFIGURAÇÕES
const MSG_LIMIT_PER_CHAT = 10; 
const CHAT_LIMIT = 200; 
const HISTORY_MONTHS_LIMIT = 8;
const BUFFER_WAIT_TIME_MS = 15000; // 15 Segundos de espera para acumular contatos

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// BUFFERS GLOBAIS (Memória Volátil do Processo)
// Armazena chunks até o 'isLatest' chegar + delay
let globalContactsBuffer = [];
let globalMessagesBuffer = [];
let isProcessing = false;

export const handleHistorySync = async ({ contacts, messages, isLatest }, sock, sessionId, companyId) => {
    
    // 1. Acumula no Buffer
    if (contacts) globalContactsBuffer.push(...contacts);
    if (messages) globalMessagesBuffer.push(...messages);

    // Feedback visual inicial (Ativa a barra de 'Preparando' no frontend)
    await updateSyncStatus(sessionId, 'importing_contacts', 1);
    console.log(`📚 [BUFFER] Recebido chunk. Total acumulado: ${globalContactsBuffer.length} contatos, ${globalMessagesBuffer.length} mensagens. Latest: ${isLatest}`);

    // 2. Se não for o último, só acumula e retorna
    if (!isLatest) return;

    // 3. Se já estiver processando (concorrência), ignora
    if (isProcessing) return;
    isProcessing = true;

    try {
        // 4. DELAY ESTRATÉGICO (O Segredo dos Nomes)
        // Espera 15s para garantir que todos os eventos paralelos de 'contacts.upsert' do Baileys
        // tenham tempo de bater no banco antes de processarmos as mensagens.
        console.log(`⏳ [SYNC] Aguardando ${BUFFER_WAIT_TIME_MS / 1000}s para estabilizar nomes...`);
        await sleep(BUFFER_WAIT_TIME_MS);

        console.log(`🚀 [SYNC] Iniciando processamento UNIFICADO.`);
        
        // --- PROCESSAMENTO DE CONTATOS ---
        // Mesmo com o upsert paralelo, reforçamos aqui com o que veio no histórico
        if (globalContactsBuffer.length > 0) {
            const uniqueContacts = new Map();
            globalContactsBuffer.forEach(c => uniqueContacts.set(c.id, c));
            
            const contactsList = Array.from(uniqueContacts.values());
            console.log(`👤 [SYNC] Salvando ${contactsList.length} contatos do histórico...`);

            // Processa em lotes pequenos para não travar o banco
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
                await sleep(50); // Pausa para o banco respirar
            }
        }

        // --- FILTRAGEM DE MENSAGENS ---
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
                // Tenta injetar nome do pushName se disponível na mensagem
                if (clean.pushName) clean._forcedName = clean.pushName;
                
                chats[jid].push(clean);
            });

            // Ordena Chats
            const sortedChatJids = Object.keys(chats).sort((a, b) => {
                const lastA = chats[a][chats[a].length - 1]?.messageTimestamp || 0;
                const lastB = chats[b][chats[b].length - 1]?.messageTimestamp || 0;
                return lastB - lastA;
            });

            // Seleciona Top N Chats e Top M Msgs
            const targetJids = sortedChatJids.slice(0, CHAT_LIMIT);
            
            for (const jid of targetJids) {
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
                
                // Atualiza last_message_at
                const latest = chats[jid][0];
                if (latest) {
                    const ts = new Date(Number(latest.messageTimestamp) * 1000);
                    supabase.from('contacts').update({ last_message_at: ts }).eq('company_id', companyId).eq('jid', jid).then();
                }

                const msgs = chats[jid].slice(0, MSG_LIMIT_PER_CHAT);
                msgs.reverse(); // Cronológico para inserção
                messagesToProcess.push(...msgs);
            }
        }

        // --- PROCESSAMENTO DE MENSAGENS (COM BARRA REAL) ---
        const total = messagesToProcess.length;
        console.log(`📥 [SYNC] Total Final Filtrado: ${total} mensagens.`);
        
        // Muda status para "Baixando Histórico" (Frontend para de usar animação fake e usa percent real)
        await updateSyncStatus(sessionId, 'importing_messages', 0);

        if (total > 0) {
            let processed = 0;
            const logInterval = Math.max(Math.floor(total * 0.05), 5); // Log a cada 5%

            for (const msg of messagesToProcess) {
                try {
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, { 
                        downloadMedia: true, 
                        createLead: true 
                    });
                    
                    processed++;

                    if (processed % logInterval === 0 || processed === total) {
                        const percent = Math.floor((processed / total) * 100);
                        console.log(`⏳ [SYNC] ${processed}/${total} (${percent}%)`);
                        // Envia progresso real
                        await updateSyncStatus(sessionId, 'importing_messages', percent);
                    }
                } catch (err) {
                    console.error("Msg error", err);
                }
                // Pequeno delay para não engasgar CPU
                if (processed % 20 === 0) await sleep(10);
            }
        }

        console.log(`✅ [SYNC] Concluído 100%. Limpando buffers.`);
        
        // 5. FINALIZAÇÃO
        // Limpa buffers
        globalContactsBuffer = [];
        globalMessagesBuffer = [];
        
        // Força 100% e Completed
        await updateSyncStatus(sessionId, 'completed', 100);

    } catch (e) {
        console.error("❌ [SYNC FATAL]", e);
    } finally {
        isProcessing = false;
    }
};
