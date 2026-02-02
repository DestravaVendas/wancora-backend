
import { upsertContact, updateSyncStatus, normalizeJid } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 20; // Aumentado para garantir contexto
const HISTORY_MONTHS_LIMIT = 12; // 1 ano de histórico

// Helper: Pausa para não bloquear o Event Loop e evitar Rate Limit do WhatsApp
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    // Calcula progresso visual
    const currentProgress = isLatest ? 100 : (progress || 10);
    console.log(`📚 [SYNC] Processando Histórico... (${currentProgress}%)`);
    await updateSyncStatus(sessionId, 'importing_messages', currentProgress);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: CONTATOS & FOTOS (O Segredo da Identidade)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            console.log(`👤 [SYNC] Enriquecendo ${contacts.length} contatos...`);
            
            // Processa em série para não tomar ban por flood de requests de foto
            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid) continue;
                
                const bestName = c.name || c.verifiedName || c.notify;
                
                // Tenta pegar foto se não vier no payload (Comum no History Sync)
                let profilePic = c.imgUrl || null;
                
                // Se não tem foto, tenta buscar ativamente (Smart Fetch)
                if (!profilePic && !jid.includes('@g.us')) {
                    try {
                        // Delay minúsculo para não floodar
                        await sleep(200); 
                        profilePic = await sock.profilePictureUrl(jid, 'image');
                    } catch (e) {
                        // 401/404 é normal (sem foto ou privado)
                    }
                }

                // Armazena em memória para uso rápido nas mensagens
                contactsMap.set(jid, { name: bestName, imgUrl: profilePic });

                // Salva no Banco IMEDIATAMENTE
                await upsertContact(jid, companyId, bestName, profilePic, !!c.name, c.lid);
            }
        }

        // -----------------------------------------------------------
        // ETAPA 2: MENSAGENS (Com Garantia de Contato)
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
                
                // Name Hunter V2: Se temos o nome no mapa (Etapa 1), injetamos na mensagem
                // Isso ajuda o messageHandler a criar o Lead com nome certo
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
                // Ordena cronologicamente
                chats[jid].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                
                // Pega as últimas X mensagens
                const messagesToSave = chats[jid].slice(-HISTORY_MSG_LIMIT);
                
                // Atualiza data do contato para ordenação (Last Message At)
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
                    // Configuração: createLead: true garante que quem mandou mensagem vire lead
                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, { 
                        downloadMedia: false, // Histórico não baixa mídia auto (economia)
                        fetchProfilePic: false, // Já fizemos na Etapa 1
                        createLead: true 
                    });
                }
                
                await sleep(50); // Respiro para o banco
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
