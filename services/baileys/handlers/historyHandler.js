
import { upsertContactsBulk, updateSyncStatus, normalizeJid, upsertContact } from '../../crm/sync.js'; 
import { handleMessage } from './messageHandler.js';
import { unwrapMessage } from '../../../utils/wppParsers.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const HISTORY_MSG_LIMIT = 30; // Aumentado para garantir mais contexto recente
const HISTORY_MONTHS_LIMIT = 6;
const processedHistoryChunks = new Set();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const resetHistoryState = (sessionId) => {
    for (const key of processedHistoryChunks) {
        if (key.startsWith(sessionId)) {
            processedHistoryChunks.delete(key);
        }
    }
};

const fetchProfilePicsInBackground = async (sock, contacts, companyId) => {
    const CONCURRENCY = 3; // Conservador para não tomar rate limit na foto
    const DELAY = 800;
    
    (async () => {
        for (let i = 0; i < contacts.length; i += CONCURRENCY) {
            const chunk = contacts.slice(i, i + CONCURRENCY);
            await Promise.all(chunk.map(async (c) => {
                try {
                    const newUrl = await sock.profilePictureUrl(c.jid, 'image').catch(() => null);
                    if (newUrl) {
                        // Atualiza apenas a foto, sem tocar no nome para não sobrescrever
                        await upsertContact(c.jid, companyId, null, newUrl, false, null, false, null, { profile_pic_updated_at: new Date() });
                    }
                } catch (e) {}
            }));
            await sleep(DELAY);
        }
    })();
};

export const handleHistorySync = async ({ contacts, messages, isLatest, progress }, sock, sessionId, companyId, chunkCounter) => {
    
    const chunkKey = `${sessionId}-chunk-${chunkCounter}`;
    if (processedHistoryChunks.has(chunkKey)) return;
    processedHistoryChunks.add(chunkKey);

    // Ajuste de progresso visual
    const estimatedProgress = progress || Math.min(10 + (chunkCounter * 2), 95);
    console.log(`📚 [SYNC] Lote ${chunkCounter} | Contatos Brutos: ${contacts?.length || 0} | Msgs: ${messages?.length || 0}`);
    
    await updateSyncStatus(sessionId, 'importing_contacts', estimatedProgress);

    try {
        // MAPA MESTRE DE CONTATOS (JID -> Dados)
        // Usamos um Map para garantir unicidade e atualização rápida
        const contactsMap = new Map();
        const contactsToFetchPic = [];

        // --- FASE 1: CARREGAR DADOS DA AGENDA (Se houver) ---
        if (contacts && contacts.length > 0) {
            for (const c of contacts) {
                const jid = normalizeJid(c.id);
                if (!jid || jid.includes('@lid') || jid === 'status@broadcast') continue;

                // Tenta extrair o melhor nome disponível na estrutura do contato
                // O campo 'name' geralmente é o que está salvo na agenda do celular
                const phoneName = c.name || c.notify || c.verifiedName;
                const isFromBook = !!(c.name && c.name.trim().length > 0);

                contactsMap.set(jid, { 
                    jid,
                    name: phoneName, 
                    isFromBook: isFromBook, // Flag vital: Se true, nunca sobrescrevemos este nome
                    imgUrl: c.imgUrl,
                    verifiedName: c.verifiedName
                });

                // Link de identidade (Multi-Device)
                if (c.lid) {
                     supabase.rpc('link_identities', {
                        p_lid: normalizeJid(c.lid),
                        p_phone: jid,
                        p_company_id: companyId
                    }).then(() => {});
                }
            }
        }

        // --- FASE 2: MINERAÇÃO DE NOMES NAS MENSAGENS (Name Harvesting) ---
        // Muitas vezes o contato vem sem nome na lista 'contacts', mas tem o 'pushName' na mensagem.
        // Vamos varrer as mensagens para preencher as lacunas do contactsMap.
        if (messages && messages.length > 0) {
            messages.forEach(msg => {
                const clean = unwrapMessage(msg);
                if (!clean.key) return;
                
                const remoteJid = normalizeJid(clean.key.remoteJid);
                const participant = clean.key.participant ? normalizeJid(clean.key.participant) : null;
                
                // Define quem é o "dono" do nome nesta mensagem
                // Se for grupo, o nome é do participante. Se for PV, é do remoteJid.
                const targetJid = participant || remoteJid;

                if (targetJid && !targetJid.includes('status@broadcast') && clean.pushName) {
                    const existing = contactsMap.get(targetJid);
                    
                    // Se o contato não existe no mapa, ou existe mas NÃO veio da agenda (está sem nome),
                    // usamos o pushName da mensagem.
                    if (!existing || (!existing.isFromBook && !existing.name)) {
                        contactsMap.set(targetJid, {
                            jid: targetJid,
                            name: clean.pushName,
                            isFromBook: false, // É um nome de perfil, não de agenda
                            imgUrl: existing?.imgUrl,
                            verifiedName: existing?.verifiedName
                        });
                    }
                }
            });
        }

        // --- FASE 3: PERSISTÊNCIA PRIORITÁRIA (Salvar Contatos ANTES das Mensagens) ---
        // Agora temos uma lista "Enriquecida". Vamos salvar no banco.
        const bulkPayload = [];
        
        for (const [jid, data] of contactsMap.entries()) {
             const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
             const contactData = {
                jid: jid,
                phone: purePhone,
                company_id: companyId,
                updated_at: new Date()
            };

            // Lógica de Ouro:
            // Se isFromBook é true, salvamos em 'name' (Agenda).
            // Se não, salvamos em 'push_name' (Perfil), mas deixamos 'name' null para o frontend formatar ou usuário editar.
            if (data.isFromBook) {
                contactData.name = data.name;
            } else if (data.name) {
                contactData.push_name = data.name;
            }

            if (data.imgUrl) {
                contactData.profile_pic_url = data.imgUrl;
            } else {
                // Se não tem foto, adiciona na fila para baixar em background
                contactsToFetchPic.push({ jid, profile_pic_url: null });
            }

            if (data.verifiedName) {
                contactData.verified_name = data.verifiedName;
                contactData.is_business = true;
            }

            bulkPayload.push(contactData);
        }

        if (bulkPayload.length > 0) {
            const BATCH_SIZE = 500;
            for (let i = 0; i < bulkPayload.length; i += BATCH_SIZE) {
                // Upsert que respeita dados existentes
                await upsertContactsBulk(bulkPayload.slice(i, i + BATCH_SIZE));
            }
            console.log(`✅ [SYNC] ${bulkPayload.length} contatos sincronizados/atualizados.`);
        }
            
        // Dispara worker de fotos (não bloqueante)
        if (contactsToFetchPic.length > 0) {
            fetchProfilePicsInBackground(sock, contactsToFetchPic, companyId);
        }

        // --- FASE 4: PROCESSAMENTO DE MENSAGENS E LEADS ---
        if (messages && messages.length > 0) {
            await updateSyncStatus(sessionId, 'importing_messages', estimatedProgress + 2);
            
            const cutoffDate = new Date();
            cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS_LIMIT);
            const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

            // Agrupa por Chat para pegar apenas as últimas N mensagens de cada conversa
            const chats = {}; 
            
            messages.forEach(msg => {
                let clean;
                try { clean = unwrapMessage(msg); } catch(e) { return; } 

                if (!clean.key?.remoteJid) return;
                
                const msgTs = Number(clean.messageTimestamp);
                if (msgTs < cutoffTimestamp) return; // Ignora muito antigas

                const jid = normalizeJid(clean.key.remoteJid);
                if (!jid || jid === 'status@broadcast') return;

                if (!chats[jid]) chats[jid] = [];
                
                // Injeta o nome que já resolvemos na Fase 2 para garantir criação correta do Lead
                const knownContact = contactsMap.get(jid);
                if (knownContact) {
                    clean._forcedName = knownContact.isFromBook ? knownContact.name : knownContact.name; // Usa o melhor nome disponível
                } else {
                    clean._forcedName = clean.pushName;
                }
                
                chats[jid].push(clean);
            });

            const chatJids = Object.keys(chats);

            for (const jid of chatJids) {
                // Ordena: Mais recentes no final do array
                chats[jid].sort((a, b) => (Number(a.messageTimestamp) || 0) - (Number(b.messageTimestamp) || 0)); 
                
                // Pega as últimas N
                const topMessages = chats[jid].slice(-HISTORY_MSG_LIMIT);
                
                // Atualiza data da conversa no contato (para ordenação da lista)
                const latestMsg = topMessages[topMessages.length - 1];
                if (latestMsg && latestMsg.messageTimestamp) {
                    const ts = new Date(Number(latestMsg.messageTimestamp) * 1000);
                    // Fire and forget update
                    supabase.from('contacts').update({ last_message_at: ts }).eq('company_id', companyId).eq('jid', jid).then();
                }

                // Salva mensagens uma a uma
                for (const msg of topMessages) {
                    try {
                        const options = { 
                            downloadMedia: false, // Mídia histórica não baixa automático para economizar espaço
                            fetchProfilePic: false, // Já tratado na Fase 3
                            createLead: true // IMPORTANTE: Cria lead para conversas ativas
                        };
                        
                        await handleMessage(msg, sock, companyId, sessionId, false, msg._forcedName, options);
                    } catch (msgError) {
                        // Silencioso para não spammar log
                    }
                }
                // Pequeno delay para liberar event loop do Node
                await sleep(2); 
            }
        }

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
    } finally {
        if (isLatest) {
            console.log(`✅ [HISTÓRICO] Sincronização Total Concluída.`);
            await updateSyncStatus(sessionId, 'completed', 100);
            resetHistoryState(sessionId);
        }
    }
};
