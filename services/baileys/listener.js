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
        // CORREÇÃO: Template string corrigida
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
            console.warn(`⚠️ [HISTÓRICO] Disparo duplicado ignorado para evitar erro.`);
            return;
        }
        isProcessingHistory = true;

        try {
            console.log(`📚 [HISTÓRICO] Iniciando Processamento Único...`);
            console.log(`   - Contatos: ${contacts.length}`);
            console.log(`   - Mensagens: ${messages.length}`);
            
            // Força o frontend a mostrar a barra imediatamente
            await updateSyncStatus(sessionId, 'syncing', 1);

           // --- MAPA DE NOMES (NAME HUNTER V3) ---
           const contactsMap = new Map();

            if (contacts) {
            contacts.forEach(c => {
           // Tenta achar nome em qualquer campo possível
           const bestName = c.notify || c.name || c.verifiedName || c.short;
        
           // Só salva se NÃO for apenas números
           if (bestName && !/^\d+$/.test(bestName.replace(/\D/g, ''))) {
            contactsMap.set(c.id, bestName);
            contactsMap.set(cleanJid(c.id), bestName); // Mapeia versão limpa também
           }
        });
       }
            console.log(`🗺️ [MAPA] ${namesCount} nomes reais identificados na memória.`);

            // A. Salva Contatos da Lista (Garante que os nomes existam antes das msgs)
            const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net'));
            for (const c of validContacts) {
                const nameToSave = contactsMap.get(c.id) || contactsMap.get(cleanJid(c.id));
                // Pequeno delay para desafogar o banco
                await new Promise(r => setTimeout(r, 10)); 
                await upsertContact(c.id, companyId, nameToSave || null);
            }

            // B. Grupos (Salva o Subject como Nome)
            try {
                const groups = await sock.groupFetchAllParticipating();
                const groupList = Object.values(groups);
                console.log(`👥 [GRUPOS] ${groupList.length} grupos.`);
                for (const g of groupList) {
                    await upsertContact(g.id, companyId, g.subject, null);
                }
            } catch (e) {}

            // C. Filtros de Mensagens
            const MAX_CHATS = 50;            
            const MAX_MSGS_PER_CHAT = 15;
            
            const messagesByChat = new Map();
            messages.forEach(msg => {
                const unwrapped = unwrapMessage(msg);
                const jid = unwrapped.key.remoteJid;
                if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
                messagesByChat.get(jid).push(unwrapped);
            });

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
            console.log(`🧠 [FILTRO] ${totalMsgs} mensagens prontas para Sync Sequencial.`);

            // D. PROCESSAMENTO SEQUENCIAL (AQUI A BARRA DEVE ANDAR)
            let processedCount = 0;
            
            for (const msg of finalMessagesToProcess) {
                // Passa o contactsMap para tentar achar o nome se não vier na msg
                await processSingleMessage(msg, sock, companyId, sessionId, false, contactsMap);
                
                processedCount++;
                
                // Atualiza a cada 3 mensagens (Feedback rápido)
                if (processedCount % 3 === 0) {
                    const percent = Math.round((processedCount / totalMsgs) * 100);
                    // LOG OBRIGATÓRIO PARA DEBUG
                    console.log(`🔄 [SYNC] ${percent}% (${processedCount}/${totalMsgs})`);
                    await updateSyncStatus(sessionId, 'syncing', percent);
                }
            }

            await updateSyncStatus(sessionId, 'online', 100);
            console.log(`✅ [HISTÓRICO] Concluído com sucesso.`);

        } catch (e) {
            console.error(`❌ [ERRO HISTÓRICO]`, e);
        } finally {
            // Libera a trava após 15 segundos (segurança)
            setTimeout(() => { isProcessingHistory = false; }, 15000);
        }
    });

    // --- Eventos Realtime ---
    sock.ev.on('groups.update', async (groups) => {
        for (const g of groups) if (g.subject) await upsertContact(g.id, companyId, g.subject);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify' || type === 'append') {
            for (const msg of messages) {
                const clean = unwrapMessage(msg);
                await processSingleMessage(clean, sock, companyId, sessionId, true);
            }
        }
    });

    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const c of contacts) {
            const bestName = c.notify || c.name || c.verifiedName || null;
            await upsertContact(c.id, companyId, bestName, c.imgUrl || null);
        }
    });
};

// ==============================================================================
// PROCESSADOR UNITÁRIO
// ==============================================================================
const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime, contactsMap = null) => {
    try {
        if (!msg.message) return;
        const jid = msg.key.remoteJid;
        if (jid === 'status@broadcast') return;

        const fromMe = msg.key.fromMe;
        
      // --- NAME HUNTER V3 (CORRIGIDO) ---
      let finalName = msg.pushName;

      // Se não veio na mensagem, tenta buscar no mapa de memória
      if (!finalName && contactsMap) {
       const clean = cleanJid(jid);
       finalName = contactsMap.get(jid) || contactsMap.get(clean);
      }

      // Manda salvar no banco
      await upsertContact(jid, companyId, finalName);
        
        // Fallback seguro para getContentType
        const type = getContentType(msg.message) || Object.keys(msg.message)[0];
        const body = getBody(msg.message);

        let leadId = null;
        // BLOQUEIO EXPLÍCITO DE GRUPOS COMO LEADS
        // Removemos o IF. Agora ele tenta criar lead para tudo.
        // A proteção deve estar DENTRO da função ensureLeadExists se você não quiser grupos.
        leadId = await ensureLeadExists(jid, companyId, finalName);

        // Mídia
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
