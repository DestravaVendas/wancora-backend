
import { upsertContact, ensureLeadExists, updateSyncStatus } from '../../crm/sync.js';
import { handleMessage } from './messageHandler.js';
import { unwrapMessage, normalizeJid } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CONFIGURAÇÃO: Regras de Negócio
const HISTORY_MSG_LIMIT = 10; // Apenas as 10 últimas
const HISTORY_MONTHS_LIMIT = 8; // Apenas últimos 8 meses

// Cache em memória para evitar reprocessamento durante a mesma sessão
const processedHistoryChunks = new Set();

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    // 1. Evita Duplicação de Lotes
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) {
        console.log(`⏩ [HISTÓRICO] Lote ${chunkCounter} já processado. Ignorando.`);
        return;
    }
    processedHistoryChunks.add(chunkKey);

    // Verifica se já completou no banco (Persistência)
    const { data: currentInstance } = await supabase.from('instances')
        .select('sync_status')
        .eq('session_id', sessionId)
        .eq('company_id', companyId)
        .single();
        
    if (currentInstance?.sync_status === 'completed') {
        return;
    }

    console.log(`📚 [HISTÓRICO] Smart Sync: Processando Lote ${chunkCounter} (Progresso: ${progress || '?'}%)...`);

    try {
        const contactsMap = new Map();

        // -----------------------------------------------------------
        // ETAPA 1: BAIXAR CONTATOS & CRIAR LEADS (PRIORIDADE MÁXIMA)
        // -----------------------------------------------------------
        if (contacts && contacts.length > 0) {
            await updateSyncStatus(sessionId, 'importing_contacts', 10);
            
            console.log(`👤 [SMART SYNC] Processando ${contacts.length} contatos da agenda...`);

            // Mapeia para inserção em lote
            const upsertPromises = contacts.map(async (c) => {
                const jid = normalizeJid(c.id);
                if (!jid) return;
                
                // Salva no mapa para uso posterior nas mensagens
                const bestName = c.name || c.verifiedName || c.notify;
                contactsMap.set(jid, { 
                    name: bestName, 
                    imgUrl: c.imgUrl, 
                    isFromBook: !!c.name, // Flag crítica: Veio da agenda?
                    lid: c.lid || null 
                });

                // Upsert Contato
                await upsertContact(jid, companyId, bestName, c.imgUrl, !!c.name, c.lid);

                // Transforma em Lead IMEDIATAMENTE (se não for grupo/canal)
                if (!jid.includes('@g.us') && !jid.includes('@newsletter') && bestName) {
                    await ensureLeadExists(jid, companyId, bestName, sock.user?.id);
                }
            });

            await Promise.all(upsertPromises);
        }

        // -----------------------------------------------------------
        // ETAPA 2: MENSAGENS (FILTRO DE 8 MESES & TOP 10)
        // -----------------------------------------------------------
        if (messages && messages.length > 0) {
            await updateSyncStatus(sessionId, 'importing_messages', 30);

            // Data de Corte (8 Meses atrás)
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // A) Agrupamento por Chat
            const chats = {}; 
            
            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) return;
                
                // Filtro de Data (No Loop inicial para performance)
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return;

                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') return;

                if (!chats[jid]) chats[jid] = [];
                
                // Tenta resgatar nome do contato processado na Etapa 1
                const knownContact = contactsMap.get(jid);
                clean._forcedName = knownContact ? knownContact.name : clean.pushName;
                
                chats[jid].push(clean);
            });

            // B) Processamento dos Chats
            const chatJids = Object.keys(chats);
            console.log(`🔍 [SMART SYNC] Analisando ${chatJids.length} conversas ativas (após filtro de data)...`);

            let totalImported = 0;

            for (const jid of chatJids) {
                // Ordena: Mais recente primeiro
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
                
                // Pega apenas as Top 10
                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT);
                
                // Reverte para ordem cronológica (Antiga -> Nova) para salvar corretamente
                topMessages.reverse();
                
                // Processa sequencialmente
                for (const msg of topMessages) {
                    // Opções para não travar o bot: Baixa mídia sim, mas com timeout
                    const options = {
                        downloadMedia: true, 
                        fetchProfilePic: true // Tenta pegar foto se não tiver
                    };

                    await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    totalImported++;
                }
            }
            
            console.log(`📥 [SMART SYNC] Importadas ${totalImported} mensagens recentes.`);
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        if (isLatest) {
            await updateSyncStatus(sessionId, 'completed', 100);
            console.log(`✅ [HISTÓRICO] Smart Sync Completo e Finalizado.`);
            processedHistoryChunks.clear(); // Limpa memória
        }
    }
};
