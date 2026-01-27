
import { upsertContact, updateSyncStatus, normalizeJid } from '../../crm/sync.js';
import { handleMessage, unwrapMessage } from './messageHandler.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CONFIGURAÇÃO: Limite de mensagens por conversa no histórico inicial
const HISTORY_MSG_LIMIT = 10;

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

    // Aceita apenas o primeiro chunk para não sobrecarregar
    // (O Baileys geralmente manda o mais recente primeiro ou em um chunk único se não for gigante)
    if (chunkCounter > 2) {
        console.log(`⏩ [HISTÓRICO] Otimização: Ignorando lote histórico profundo ${chunkCounter}.`);
        await updateSyncStatus(sessionId, 'completed', 100);
        return;
    }

    console.log(`📚 [HISTÓRICO] Smart Sync: Processando Lote ${chunkCounter}...`);

    try {
        const contactsMap = new Map();

        // 1. Processar Contatos (Batch Rápido)
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

            // Upsert em lotes de 20
            const uniqueJids = Array.from(contactsMap.keys());
            const BATCH_SIZE = 20;
            
            for (let i = 0; i < uniqueJids.length; i += BATCH_SIZE) {
                const batchJids = uniqueJids.slice(i, i + BATCH_SIZE);
                await Promise.all(batchJids.map(async (jid) => {
                    let data = contactsMap.get(jid);
                    await upsertContact(jid, companyId, data.name, data.imgUrl, data.isFromBook, data.lid);
                }));
            }
        }

        // 2. Processar Mensagens (Filtro Inteligente: Top 10 por Chat)
        if (messages && messages.length > 0) {
            
            // A) Agrupamento
            const chats = {}; // Map<RemoteJid, Message[]>
            
            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key?.remoteJid) return;
                const jid = normalizeJid(clean.key.remoteJid);
                if (jid === 'status@broadcast') return;

                // Name Hunter (Cache Local)
                if (!clean.key.fromMe && clean.pushName) {
                    const existing = contactsMap.get(jid);
                    if (!existing || !existing.name) {
                        // Salva nome se não tivermos
                        contactsMap.set(jid, { name: clean.pushName });
                        upsertContact(jid, companyId, clean.pushName, null, false);
                    }
                }

                if (!chats[jid]) chats[jid] = [];
                // Injeta nome forçado
                const mapData = contactsMap.get(jid);
                clean._forcedName = clean.pushName || (mapData ? mapData.name : null);
                
                chats[jid].push(clean);
            });

            // B) Filtragem (Sort & Slice)
            let curatedMessages = [];
            const chatJids = Object.keys(chats);
            
            console.log(`🔍 [SMART SYNC] Analisando ${chatJids.length} conversas...`);

            chatJids.forEach(jid => {
                // Ordena: Mais recente primeiro
                chats[jid].sort((a, b) => (b.messageTimestamp || 0) - (a.messageTimestamp || 0));
                
                // Pega apenas as Top N
                const topMessages = chats[jid].slice(0, HISTORY_MSG_LIMIT);
                
                // Reverte para ordem cronológica (Antiga -> Nova) para salvar corretamente no banco
                topMessages.reverse();
                
                curatedMessages.push(...topMessages);
            });

            // C) Processamento Rico (Com Mídia e Fotos)
            const total = curatedMessages.length;
            console.log(`📥 [SMART SYNC] Importando ${total} mensagens relevantes (Top ${HISTORY_MSG_LIMIT}/chat)...`);
            await updateSyncStatus(sessionId, 'importing_messages', 10);

            let processed = 0;
            let lastLoggedPercent = 0;

            // Processa sequencialmente para não estourar memória com downloads simultâneos
            for (const msg of curatedMessages) {
                
                // Opções Especiais para Histórico Recente:
                // - downloadMedia: TRUE (Baixa mídia dessas mensagens selecionadas)
                // - fetchProfilePic: TRUE (Busca foto se for a primeira msg do chat processada)
                const options = {
                    downloadMedia: true, 
                    fetchProfilePic: true 
                };

                await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                
                processed++;
                const percent = Math.min(99, Math.floor((processed / total) * 100));
                
                if (percent >= lastLoggedPercent + 10) {
                    await updateSyncStatus(sessionId, 'importing_messages', percent);
                    lastLoggedPercent = percent;
                }
            }
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        await updateSyncStatus(sessionId, 'completed', 100);
        console.log(`✅ [HISTÓRICO] Smart Sync Finalizado com Sucesso.`);
    }
};
