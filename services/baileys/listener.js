import { 
    upsertContact, 
    upsertMessage, 
    ensureLeadExists, 
    updateSyncStatus 
} from '../crm/sync.js';
import { 
    getContentType, 
    downloadMediaMessage 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'silent' }); // Silent para reduzir lixo no terminal

// --- Helpers Internos ---

// Desenrola mensagens complexas (ViewOnce, Ephemeral, etc)
const unwrapMessage = (msg) => {
    if (!msg.message) return msg;
    let content = msg.message;
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    if (content.viewOnceMessage) content = content.viewOnceMessage.message;
    if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
    if (content.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;
    return { ...msg, message: content };
};

// Faz upload de mídia para o bucket do Supabase
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

// Extrai texto legível de qualquer tipo de mensagem
const getBody = (msg) => {
    if (!msg) return '';
    return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
};

// ==============================================================================
// CONFIGURAÇÃO DOS LISTENERS (FUNÇÃO PRINCIPAL)
// ==============================================================================
export const setupListeners = ({ sock, sessionId, companyId }) => {

    // --- 1. EVENTO: HISTÓRICO INTELIGENTE (SYNC INICIAL) ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        console.log(`📚 [HISTÓRICO] Recebido pacote do WhatsApp. Iniciando filtros...`);
        
        // Avisa o Frontend: "Começou a sincronizar (0%)"
        await updateSyncStatus(sessionId, 'syncing', 0);

        // A. Salva Contatos Primeiro (É rápido)
        const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net'));
        if (validContacts.length > 0) {
            await Promise.all(validContacts.map(c => 
                upsertContact(c.id, companyId, c.notify || c.name || null)
            ));
        }

        // B. Aplica os Filtros do Build Arquiteto
        const MAX_CHATS = 200;           // Limite de conversas
        const MAX_MSGS_PER_CHAT = 7;     // Limite de mensagens por conversa
        
        // 1. Agrupa mensagens por JID (Chat)
        const messagesByChat = new Map();
        messages.forEach(msg => {
            const unwrapped = unwrapMessage(msg);
            const jid = unwrapped.key.remoteJid;
            if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
            messagesByChat.get(jid).push(unwrapped);
        });

        // 2. Ordena os chats pelo timestamp da mensagem mais recente
        const sortedChats = Array.from(messagesByChat.entries()).sort(([, msgsA], [, msgsB]) => {
            const timeA = Math.max(...msgsA.map(m => m.messageTimestamp || 0));
            const timeB = Math.max(...msgsB.map(m => m.messageTimestamp || 0));
            return timeB - timeA; // Decrescente (Mais novo primeiro)
        });

        // 3. Corta apenas os Top 200 chats
        const topChats = sortedChats.slice(0, MAX_CHATS);
        
        // 4. Prepara a lista final "achatada" (Flat)
        let finalMessagesToProcess = [];
        topChats.forEach(([jid, msgs]) => {
            // Ordena mensagens dentro do chat (Antiga -> Nova)
            msgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
            
            // Pega apenas as últimas 7
            const limited = msgs.slice(-MAX_MSGS_PER_CHAT);
            finalMessagesToProcess.push(...limited);
        });

        const totalMsgs = finalMessagesToProcess.length;
        console.log(`🧠 [FILTRO] ${messagesByChat.size} chats totais -> Reduzido para ${topChats.length} chats. Total Msgs finais: ${totalMsgs}`);

        // C. Processamento em Lotes (Chunks) com Log de Progresso
        const CHUNK_SIZE = 10; // Processa de 10 em 10 para atualizar a barra de progresso suavemente
        let processedCount = 0;

        for (let i = 0; i < finalMessagesToProcess.length; i += CHUNK_SIZE) {
            const chunk = finalMessagesToProcess.slice(i, i + CHUNK_SIZE);
            
            // Processa o lote em paralelo. 'false' = Não baixa mídia antiga (economiza espaço)
            await Promise.all(chunk.map(msg => processSingleMessage(msg, sock, companyId, sessionId, false)));
            
            processedCount += chunk.length;
            
            // Calcula Porcentagem
            const percent = Math.round((processedCount / totalMsgs) * 100);
            
            // Log no Console
            if (percent % 10 === 0) console.log(`🔄 [SYNC] ${percent}% processado (${processedCount}/${totalMsgs})`);
            
            // Atualiza Banco para o Frontend ler
            await updateSyncStatus(sessionId, 'syncing', percent);
        }

        // Finaliza: Marca como 100% e Online
        await updateSyncStatus(sessionId, 'online', 100);
        console.log(`✅ [HISTÓRICO] Sincronização concluída com sucesso.`);
    });

    // --- 2. EVENTO: MENSAGEM EM TEMPO REAL (NOVA MENSAGEM) ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify' || type === 'append') {
            for (const msg of messages) {
                const clean = unwrapMessage(msg);
                // 'true' = Baixa mídia automaticamente, pois é mensagem nova
                await processSingleMessage(clean, sock, companyId, sessionId, true);
            }
        }
    });

    // --- 3. EVENTO: ATUALIZAÇÃO DE CONTATOS ---
    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const c of contacts) {
            await upsertContact(c.id, companyId, c.notify || null, c.imgUrl || null);
        }
    });
};

// ==============================================================================
// PROCESSADOR UNITÁRIO DE MENSAGEM (LÓGICA CENTRAL)
// ==============================================================================
const processSingleMessage = async (msg, sock, companyId, sessionId, isRealtime) => {
    try {
        if (!msg.message) return;
        const jid = msg.key.remoteJid;
        
        // Ignora status (stories)
        if (jid === 'status@broadcast') return;

        const fromMe = msg.key.fromMe;
        const pushName = msg.pushName;
        const type = getContentType(msg.message);
        const body = getBody(msg.message);

        // 1. Garante que o Contato e o Lead existam
        // A função upsertContact do sync.js agora cuida da prioridade do nome
        await upsertContact(jid, companyId, pushName);
        
        let leadId = null;
        if (!jid.includes('@g.us')) {
            leadId = await ensureLeadExists(jid, companyId, pushName);
        }

        // 2. Tratamento de Mídia
        let mediaUrl = null;
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        
        // Regra: Só baixa mídia se for Tempo Real (Nova) 
        // Se for histórico, ignoramos para não lotar o servidor, a menos que você queira mudar isso.
        if (isMedia && isRealtime) { 
            try {
                // Limite de segurança: não baixa arquivos gigantes (>50MB) para não travar RAM
                // O baileys geralmente lida com stream, mas bufferizamos aqui para upload
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                
                let mimeType = 'application/octet-stream';
                if (msg.message.imageMessage) mimeType = 'image/jpeg';
                else if (msg.message.audioMessage) mimeType = 'audio/mp4';
                else if (msg.message.videoMessage) mimeType = 'video/mp4';
                else if (msg.message.stickerMessage) mimeType = 'image/webp';
                else if (msg.message.documentMessage) mimeType = msg.message.documentMessage.mimetype;
                
                mediaUrl = await uploadMedia(buffer, mimeType);
            } catch (e) {
                // Falha silenciosa no download de mídia para não perder a mensagem de texto
                // console.warn('Falha download mídia:', e.message);
            }
        }

        // 3. Salva no Banco de Dados
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
        console.error(`Erro process msg ${msg.key?.id}:`, e.message);
    }
};
