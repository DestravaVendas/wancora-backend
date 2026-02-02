
import { upsertContact, updateSyncStatus, normalizeJid } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 20; 
const HISTORY_MONTHS_LIMIT = 12;

// Helper: Pausa para não bloquear o Event Loop
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    // Calcula progresso visual
    const currentProgress = isLatest ? 100 : (progress || 10);
    console.log(`📚 [SYNC] Processando Histórico (Chunk ${chunkCounter})... (${currentProgress}%)`);
    await updateSyncStatus(sessionId, 'importing_messages', currentProgress);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: CONTATOS (Agenda & Notify)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            console.log(`👤 [SYNC] Salvando ${contacts.length} contatos da agenda...`);
            
            // Processa sequencialmente para garantir DB
            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid) continue;
                
                // EXTRAÇÃO AGRESSIVA DE NOME
                // c.name = Nome na Agenda do Celular
                // c.notify = Nome do Perfil (PushName) - MUITO IMPORTANTE SE NÃO TIVER AGENDA
                // c.verifiedName = Nome Business
                const bestName = c.name || c.notify || c.verifiedName;
                const isFromBook = !!c.name; // Só é da agenda se tiver c.name

                // Mapeia para uso rápido
                contactsMap.set(jid, { name: bestName });

                // Se não tiver foto, tentamos pegar depois, mas salvamos o contato AGORA
                // para que as mensagens tenham onde se ligar
                await upsertContact(jid, companyId, bestName, c.imgUrl || null, isFromBook, c.lid);
            }
        }

        // -----------------------------------------------------------
        // ETAPA 2: MENSAGENS & NAME HUNTING
        // -----------------------------------------------------------
        if (messages && messages.length > 0) {
            
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Agrupa por Chat
            const chats = {}; 
            
            for (const msg of messages) {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) continue;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) continue;

                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') continue;

                if (!chats[jid]) chats[jid] = [];
                
                // NAME HUNTER: Se o contato ainda não tem nome no mapa, tenta pegar da mensagem
                if (!contactsMap.has(jid) && clean.pushName) {
                    contactsMap.set(jid, { name: clean.pushName });
                    // Atualiza contato no banco "on the fly" para garantir que apareça na lista
                    await upsertContact(jid, companyId, clean.pushName, null, false, null);
                }

                // Injeta o nome descoberto na mensagem para o messageHandler usar
                if (contactsMap.has(jid)) {
                    clean._forcedName = contactsMap.get(jid).name;
                } else if (clean.pushName) {
                    clean._forcedName = clean.pushName;
                }

                chats[jid].push(clean);
            }

            const chatJids = Object.keys(chats);

            // Processa cada chat
            for (const jid of chatJids) {
                // Ordena (Antigas -> Recentes)
                chats[jid].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                
                const messagesToSave = chats[jid].slice(-HISTORY_MSG_LIMIT);
                
                // Atualiza data do contato
                const lastMsg = messagesToSave[messagesToSave.length - 1];
                if (lastMsg) {
                    const ts = new Date(Number(lastMsg.messageTimestamp) * 1000);
                    await supabase.from('contacts')
                        .update({ last_message_at: ts })
                        .eq('company_id', companyId)
                        .eq('jid', jid);
                }

                // Salva mensagens
                for (const msg of messagesToSave) {
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, { 
                        downloadMedia: false, // Performance
                        fetchProfilePic: true, // Tenta buscar foto se não tiver (Corrige falta de avatar)
                        createLead: true // Garante que apareça no Kanban
                    });
                }
                
                await sleep(20); // Respiro
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
