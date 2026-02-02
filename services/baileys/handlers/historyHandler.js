
import { upsertContact, updateSyncStatus, normalizeJid } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 15; // Aumentado ligeiramente para garantir contexto
const HISTORY_MONTHS_LIMIT = 6; // Otimização de tempo

// Helper: Pausa mínima para Event Loop (Heartbeat)
const tick = () => new Promise(r => setImmediate(r));

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    // Calcula progresso real (Se isLatest=true, força 100%)
    const currentProgress = isLatest ? 100 : (progress || 10);
    console.log(`📚 [SYNC] Processando Histórico... (${currentProgress}%)`);
    
    await updateSyncStatus(sessionId, 'importing_messages', currentProgress);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: CONTATOS (Carga Rápida)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            // Processa TODOS os contatos recebidos neste pacote de uma vez
            // O Promise.all em map é rápido, mas adicionamos um 'tick' a cada 50 para não bloquear
            
            const contactPromises = contacts.map(async (c, index) => {
                if (index % 50 === 0) await tick(); // Respiro para a CPU

                const jid = normalizeJid(c.id);
                if (!jid) return;
                
                const bestName = c.name || c.verifiedName || c.notify;
                
                // Mapeia para uso nas mensagens abaixo
                contactsMap.set(jid, { 
                    name: bestName, 
                    imgUrl: c.imgUrl, 
                    isFromBook: !!c.name 
                });

                // Upsert Imediato (Trigger no banco avisará o Frontend via INSERT)
                await upsertContact(jid, companyId, bestName, c.imgUrl || null, !!c.name, c.lid);
            });

            await Promise.all(contactPromises);
        }

        // -----------------------------------------------------------
        // ETAPA 2: MENSAGENS (Processamento & Name Hunting)
        // -----------------------------------------------------------
        if (messages && messages.length > 0) {
            
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Agrupamento por Chat
            const chats = {}; 
            
            for (const msg of messages) {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) continue;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) continue;

                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') continue;

                if (!chats[jid]) chats[jid] = [];
                
                // --- NAME HUNTER V4 ---
                // Se a mensagem tem pushName e o contato não tem nome na agenda,
                // forçamos esse nome na mensagem para que o handler atualize o contato.
                const knownContact = contactsMap.get(jid);
                const forcedName = (knownContact && knownContact.name) ? knownContact.name : clean.pushName;
                
                clean._forcedName = forcedName; // Injeta propriedade temporária
                chats[jid].push(clean);
            }

            const chatJids = Object.keys(chats);

            // Processa cada chat
            for (const jid of chatJids) {
                // Ordena cronologicamente
                chats[jid].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                
                // Pega apenas as últimas mensagens para salvar no banco
                const messagesToSave = chats[jid].slice(-HISTORY_MSG_LIMIT);
                
                // Se tiver mensagens, atualiza data do contato para ordenação correta no Frontend
                const lastMsg = messagesToSave[messagesToSave.length - 1];
                if (lastMsg) {
                    const ts = new Date(Number(lastMsg.messageTimestamp) * 1000);
                    // Atualização "Fire and Forget" para não travar
                    supabase.from('contacts')
                        .update({ last_message_at: ts })
                        .eq('company_id', companyId)
                        .eq('jid', jid)
                        .then(() => {});
                }

                // Salva as mensagens
                for (const msg of messagesToSave) {
                    // Opções de Performance: Não baixar mídia histórica, mas baixar foto de perfil se não tiver
                    const options = { 
                        downloadMedia: false, // Mídia histórica não baixa auto para economizar espaço
                        fetchProfilePic: true, // Tenta pegar foto se não tiver
                        createLead: true // Garante que chats ativos virem leads
                    };
                    
                    // Chama o handler padrão
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                }

                await tick(); // Evita travar loop
            }
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        if (isLatest) {
            console.log(`✅ [HISTÓRICO] Sincronização Finalizada.`);
            await updateSyncStatus(sessionId, 'completed', 100);
        }
    }
};
