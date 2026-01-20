
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
const cleanJid = (jid) => {
    if (!jid) return null;
    return jid.split(':')[0].split('@')[0] + (jid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net');
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
        // [TRAVA] Se já estamos processando, ignora o segundo disparo
        if (isProcessingHistory) {
            console.warn(`⚠️ [HISTÓRICO] Disparo duplicado ignorado.`);
            return;
        }
        isProcessingHistory = true;

        try {
            console.log(`📚 [HISTÓRICO] Iniciando... Sessão: ${sessionId}`);
            console.log(`   - Contatos RAW: ${contacts.length}`);
            console.log(`   - Mensagens RAW: ${messages.length}`);
            
            await updateSyncStatus(sessionId, 'syncing', 5);

            // --- MAPA DE NOMES (NAME HUNTER V4.0) ---
            // Cria um dicionário em memória para garantir que mensagens tenham nomes
            // mesmo que o banco ainda esteja processando os contatos.
            const contactsMap = new Map();
            let namesFound = 0;

            if (contacts && contacts.length > 0) {
                contacts.forEach(c => {
                    // PRIORIDADE: 1. Agenda (name) > 2. PushName (notify) > 3. Business (verifiedName)
                    const bestName = c.name || c.notify || c.verifiedName || c.short;
                    
                    if (bestName) {
                        const clean = cleanJid(c.id);
                        // Salva para ambos as chaves para garantir match
                        contactsMap.set(c.id, bestName);
                        if (clean) contactsMap.set(clean, bestName);
                        namesFound++;
                    }
                });
            }
            console.log(`🗺️ [MAPA] ${namesFound} nomes extraídos da memória.`);

            // A. Salva Contatos (Garante nomes antes das mensagens)
            // Filtra apenas contatos válidos (pessoas ou grupos)
            const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net') || c.id.endsWith('@g.us'));
            
            const batchSize = 50;
            for (let i = 0; i < validContacts.length; i += batchSize) {
                const batch = validContacts.slice(i, i + batchSize);
                await Promise.all(batch.map(async (c) => {
                    // Tenta pegar do mapa, senão tenta propriedades diretas novamente
                    const nameToSave = contactsMap.get(c.id) || c.name || c.notify;
                    // Se não tiver nome nenhum, manda null (sync.js decide se atualiza)
                    await upsertContact(c.id, companyId, nameToSave || null, c.imgUrl || null);
                }));
            }
            
            // B. Grupos (Refresh explícito de nomes de grupos)
            try {
                const groups = await sock.groupFetchAllParticipating();
                const groupList = Object.values(groups);
                console.log(`👥 [GRUPOS] Sincronizando ${groupList.length} grupos...`);
                for (const g of groupList) {
                    // Grupos sempre têm "subject" como nome
                    await upsertContact(g.id, companyId, g.subject, null);
                    contactsMap.set(g.id, g.subject); // Atualiza mapa para as mensagens usarem
                }
            } catch (e) {
                console.error("Erro ao buscar grupos:", e.message);
            }

            // C. Mensagens (Processamento)
            const MAX_CHATS = 50;            
            const MAX_MSGS_PER_CHAT = 20;
            
            const messagesByChat = new Map();
            messages.forEach(msg => {
                const unwrapped = unwrapMessage(msg);
                if(!unwrapped.key || !unwrapped.key.remoteJid) return;
                
                const jid = unwrapped.key.remoteJid;
                // Ignora status
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
                // Ordena mensagens cronologicamente (antigas -> novas)
                msgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                const limited = msgs.slice(-MAX_MSGS_PER_CHAT);
                finalMessagesToProcess.push(...limited);
            });

            const totalMsgs = finalMessagesToProcess.length;
            console.log(`🧠 [FILTRO] ${totalMsgs} mensagens selecionadas para importação.`);

            // D. Sync Sequencial
            let processedCount = 0;
            for (const msg of finalMessagesToProcess) {
                // Tenta nome da mensagem OU do mapa construído anteriormente
                const msgPushName = msg.pushName;
                const mapName = contactsMap.get(msg.key.remoteJid);
                const finalName = mapName || msgPushName; // Prioridade ao mapa (Agenda)

                await processSingleMessage(msg, sock, companyId, sessionId, false, finalName);
                processedCount++;
                if (processedCount % 10 === 0) {
                    const percent = Math.round((processedCount / totalMsgs) * 100);
                    await updateSyncStatus(sessionId, 'syncing', percent);
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
        // console.log(`👤 [CONTACTS UPSERT] Recebidos: ${contacts.length}`);
        for (const c of contacts) {
            // Prioridade Agenda > Perfil
            const bestName = c.name || c.notify || c.verifiedName || null;
            if (bestName) {
                // console.log(`   > Atualizando: ${c.id.split('@')[0]} -> ${bestName}`);
                await upsertContact(c.id, companyId, bestName, c.imgUrl || null);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify' || type === 'append') {
            for (const msg of messages) {
                const clean = unwrapMessage(msg);
                // No realtime, usamos o pushName da mensagem como fallback imediato
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
        const jid = msg.key.remoteJid;
        if (jid === 'status@broadcast') return;

        const fromMe = msg.key.fromMe;
        
        // --- NAME HUNTER V4.0 (RESOLUÇÃO FINAL) ---
        // Se recebemos um nome forçado (do mapa ou pushName), usamos.
        if (forcedName) {
            await upsertContact(jid, companyId, forcedName);
        }
        
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        const body = getBody(msg.message);

        let leadId = null;
        // BLOQUEIO EXPLÍCITO DE GRUPOS COMO LEADS
        if (!jid.includes('@g.us') && !jid.includes('-')) {
            // Se tiver nome, passamos para criar/atualizar o lead
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
        console.error(`Erro process msg:`, e.message);
    }
};
