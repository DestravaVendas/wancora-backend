
import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    updateSyncStatus
} from '../crm/sync.js';
import {
    downloadMediaMessage,
    getContentType
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'silent' });

// --- TRAVA DE SEGURANÇA (EVITA ATROPELAMENTO) ---
let isProcessingHistory = false;

// --- Helpers Internos ---
// JID Cleaner V2: Remove sufixos de dispositivo (:2, :44) para garantir match no banco e no mapa
const cleanJid = (jid) => {
    if (!jid) return null;
    const temp = jid.split('@')[0].split(':')[0]; // Remove device part
    const suffix = jid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net';
    return temp + suffix;
};

const unwrapMessage = (msg) => {
    if (!msg.message) return msg;
    let content = msg.message;
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    if (content.viewOnceMessage) content = content.viewOnceMessage.message;
    if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
    if (content.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;
    return { ...msg, message: content };
};

const uploadMedia = async (buffer, type) => {
    try {
        const ext = mime.extension(type) || 'bin';
        const fileName = `hist_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        const { error } = await supabase.storage.from('chat-media').upload(fileName, buffer, { contentType: type });
        if (error) return null;
        const { data } = supabase.storage.from('chat-media').getPublicUrl(fileName);
        return data.publicUrl;
    } catch { return null; }
};

const getBody = (msg) => {
    if (!msg) return '';
    return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
};

// ==============================================================================
// CONFIGURAÇÃO DOS LISTENERS
// ==============================================================================
export const setupListeners = ({ sock, sessionId, companyId }) => {
    
    // --- 1. HISTÓRICO INTELIGENTE (COM TRAVA) ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        if (isProcessingHistory) {
            console.warn(`⚠️ [HISTÓRICO] Ignorando duplicação de evento.`);
            return;
        }
        isProcessingHistory = true;

        try {
            console.log(`📚 [HISTÓRICO] Iniciando Sync... Sessão: ${sessionId}`);
            await updateSyncStatus(sessionId, 'importing_contacts', 5);

            // --- MAPA DE NOMES (NAME HUNTER V5.0 - SCAVENGER MODE) ---
            const contactsMap = new Map();
            let namesFound = 0;

            // PASSO 1: Agenda (Prioridade Máxima)
            if (contacts && contacts.length > 0) {
                contacts.forEach(c => {
                    const bestName = c.name || c.verifiedName || c.notify || c.short;
                    if (bestName) {
                        const jidKey = cleanJid(c.id);
                        if(jidKey) {
                            contactsMap.set(jidKey, bestName);
                            namesFound++;
                        }
                    }
                });
            }

            // PASSO 2: Varredura de Mensagens (Scavenger Hunt)
            // Procura pushNames em mensagens de pessoas que NÃO estão na agenda
            if (messages && messages.length > 0) {
                messages.forEach(msg => {
                    if (msg.key.fromMe) return; // Ignora minhas mensagens
                    const jidKey = cleanJid(msg.key.remoteJid);
                    const pushName = msg.pushName;

                    // Se temos um PushName e esse JID ainda NÃO tem nome no mapa, salvamos!
                    if (jidKey && pushName && !contactsMap.has(jidKey)) {
                        // Filtra nomes genéricos (só números)
                        if (!/^[\d\s\+\-\(\)\.]+$/.test(pushName)) {
                            contactsMap.set(jidKey, pushName);
                            namesFound++;
                        }
                    }
                });
            }

            console.log(`🗺️ [MAPA] ${namesFound} nomes reais mapeados (Agenda + Histórico).`);

            // A. Salva Contatos (Lote)
            await updateSyncStatus(sessionId, 'importing_messages', 20);
            
            // Unimos contatos oficiais + contatos descobertos nas mensagens
            const allJids = new Set([
                ...(contacts || []).map(c => cleanJid(c.id)),
                ...Array.from(contactsMap.keys())
            ]);

            const validJids = Array.from(allJids).filter(jid => jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us')));
            
            const batchSize = 100;
            for (let i = 0; i < validJids.length; i += batchSize) {
                const batch = validJids.slice(i, i + batchSize);
                await Promise.all(batch.map(async (jidKey) => {
                    // Tenta achar o objeto de contato original para pegar foto
                    const originalContact = contacts?.find(c => cleanJid(c.id) === jidKey);
                    
                    // O nome vem do nosso Mapa Inteligente
                    const nameToSave = contactsMap.get(jidKey);
                    
                    // CHECK: Se veio originalContact.name, é da Agenda!
                    const isFromBook = !!(originalContact && originalContact.name); 

                    if (nameToSave) {
                        await upsertContact(jidKey, companyId, nameToSave, originalContact?.imgUrl || null, isFromBook);
                    }
                }));
            }
            
            // B. Grupos (Refresh Forçado)
            try {
                const groups = await sock.groupFetchAllParticipating();
                const groupList = Object.values(groups);
                console.log(`👥 [GRUPOS] Sincronizando ${groupList.length} grupos...`);
                for (const g of groupList) {
                    await upsertContact(g.id, companyId, g.subject, null, true);
                    contactsMap.set(g.id, g.subject); 
                }
            } catch (e) {}

            // C. Mensagens (Processamento)
            await updateSyncStatus(sessionId, 'processing_history', 50);
            const MAX_CHATS = 60;            
            const MAX_MSGS_PER_CHAT = 25;
            
            const messagesByChat = new Map();
            messages.forEach(msg => {
                const unwrapped = unwrapMessage(msg);
                if(!unwrapped.key || !unwrapped.key.remoteJid) return;
                
                const jid = cleanJid(unwrapped.key.remoteJid); 
                if (jid === 'status@broadcast') return;

                if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                messagesByChat.get(jid).push(unwrapped);
            });

            // Ordena chats por atividade recente
            const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
                const timeA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
                const timeB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
                return timeB - timeA; 
            });

            const topChats = sortedChats.slice(0, MAX_CHATS);
            let finalMessagesToProcess = [];
            
            topChats.forEach(([jid, msgs]) => {
                msgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                const limited = msgs.slice(-MAX_MSGS_PER_CHAT);
                finalMessagesToProcess.push(...limited);
            });

            const totalMsgs = finalMessagesToProcess.length;
            console.log(`🧠 [FILTRO] ${totalMsgs} mensagens selecionadas.`);

            // D. Sync Sequencial
            let processedCount = 0;
            for (const msg of finalMessagesToProcess) {
                const jidKey = cleanJid(msg.key.remoteJid);
                
                // Prioridade: Mapa (Agenda/Verified/Scavenged) > Msg Atual (PushName)
                const msgPushName = msg.pushName;
                const mapName = contactsMap.get(jidKey);
                const finalName = mapName || msgPushName; 

                // Mensagens históricas nunca sobrescrevem agenda explicitamente (isFromBook=false)
                await processSingleMessage(msg, sock, companyId, sessionId, false, finalName);
                
                processedCount++;
                if (processedCount % 20 === 0) {
                    const percent = 50 + Math.round((processedCount / totalMsgs) * 50);
                    await updateSyncStatus(sessionId, 'processing_history', percent);
                }
            }

            await updateSyncStatus(sessionId, 'completed', 100);
            console.log(`✅ [HISTÓRICO] Importação finalizada.`);

        } catch (e) {
            console.error(`❌ [ERRO HISTÓRICO]`, e);
        } finally {
            setTimeout(() => { isProcessingHistory = false; }, 10000);
        }
    });

    // --- Eventos Realtime ---
    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const c of contacts) {
            // ORDEM RIGOROSA: Agenda > Verificado > Perfil
            const bestName = c.name || c.verifiedName || c.notify || null;
            
            if (bestName) {
                const jid = cleanJid(c.id);
                // DETECÇÃO CRÍTICA: Se 'c.name' existe, é atualização da agenda!
                const isFromBook = !!c.name;
                await upsertContact(jid, companyId, bestName, c.imgUrl || null, isFromBook);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify' || type === 'append') {
            for (const msg of messages) {
                const clean = unwrapMessage(msg);
                // Realtime: Mensagens novas podem trazer nomes (PushName)
                // Se o contato já existe com nome ruim, o sync.js vai atualizar
                await processSingleMessage(clean, sock, companyId, sessionId, true, clean.pushName);
            }
        }
    });
};

// ==============================================================================
// PROCESSADOR UNITÁRIO
// ==============================================================================
const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime, forcedName = null) => {
    try {
        if (!msg.message) return;
        const jid = cleanJid(msg.key.remoteJid);
        if (jid === 'status@broadcast') return;

        const fromMe = msg.key.fromMe;
        
        // --- NAME HUNTER V5.0 (RESOLUÇÃO FINAL) ---
        if (forcedName) {
            // isFromBook=false aqui, pois pushName não é autoridade máxima
            // Mas o sync.js vai aceitar se o banco estiver vazio/ruim
            await upsertContact(jid, companyId, forcedName);
        }
        
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        const body = getBody(msg.message);

        let leadId = null;
        if (jid && !jid.includes('@g.us')) {
            leadId = await ensureLeadExists(jid, companyId, forcedName);
        }
        
        // Mídia (Apenas Realtime)
        let mediaUrl = null;
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        
        if (isMedia && isRealtime) { 
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                let mimeType = 'application/octet-stream';
                if (msg.message.imageMessage) mimeType = 'image/jpeg';
                else if (msg.message.audioMessage) mimeType = 'audio/mp4';
                else if (msg.message.videoMessage) mimeType = 'video/mp4';
                else if (msg.message.stickerMessage) mimeType = 'image/webp';
                else if (msg.message.documentMessage) mimeType = msg.message.documentMessage.mimetype;
                mediaUrl = await uploadMedia(buffer, mimeType);
            } catch (e) {}
        }

        await upsertMessage({
            company_id: companyId,
            session_id: sessionId,
            remote_jid: jid,
            whatsapp_id: msg.key.id,
            from_me: fromMe,
            content: body || (mediaUrl ? '[Mídia]' : ''),
            media_url: mediaUrl,
            message_type: type?.replace('Message', '') || 'text',
            status: fromMe ? 'sent' : 'received',
            lead_id: leadId,
            created_at: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000)
        });

    } catch (e) {
        // console.error(`Erro process msg:`, e.message);
    }
};
