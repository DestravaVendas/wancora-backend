
import {
    upsertContact,
    upsertMessage,
    ensureLeadExists,
    updateInstanceStatus,
    normalizeJid,
    savePollVote
} from '../crm/sync.js';
import { dispatchWebhook } from '../integrations/webhook.js';
import { downloadMediaMessage, getContentType } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import mime from 'mime-types';

// Cliente Supabase Service Role para Uploads e Leitura de Config
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { 
    auth: { persistSession: false } 
});

// Cache simples para evitar processamento duplicado de IDs de mensagem em curto prazo (Deduplicação de memória)
const msgCache = new Set();

// --- HELPERS DE PARSE ---

const getBody = (msg) => {
    if (!msg) return '';
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;
    return '';
};

const unwrapMessage = (msg) => {
    if (!msg.message) return msg;
    let content = msg.message;
    
    // Desenrola camadas de abstração do Baileys
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    if (content.viewOnceMessage) content = content.viewOnceMessage.message;
    if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
    if (content.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;
    
    // Edições: Pega o conteúdo novo
    if (content.editedMessage) {
        content = content.editedMessage.message?.protocolMessage?.editedMessage || content.editedMessage.message;
    }
    return { ...msg, message: content };
};

// Upload de mídia para Supabase Storage
const processMedia = async (msg, type) => {
    try {
        const stream = await downloadMediaMessage(msg, 'buffer', {});
        // Mapeia extensão correta
        let ext = 'bin';
        let contentType = 'application/octet-stream';

        if (type === 'audioMessage') {
             ext = 'mp4'; contentType = 'audio/mp4'; 
        } else if (type === 'imageMessage') {
             ext = 'jpg'; contentType = 'image/jpeg';
        } else if (type === 'videoMessage') {
             ext = 'mp4'; contentType = 'video/mp4';
        } else if (type === 'stickerMessage') {
             ext = 'webp'; contentType = 'image/webp';
        } else if (type === 'documentMessage') {
             ext = mime.extension(msg.message.documentMessage.mimetype) || 'pdf';
             contentType = msg.message.documentMessage.mimetype;
        }

        const fileName = `${Date.now()}_${Math.random().toString(36).substr(2, 5)}.${ext}`;
        
        // Upload para bucket público
        const { error } = await supabase.storage.from('chat-media').upload(fileName, stream, {
            contentType,
            upsert: false
        });
        
        if (error) throw error;
        
        const { data } = supabase.storage.from('chat-media').getPublicUrl(fileName);
        return data.publicUrl;
    } catch (e) {
        console.error("❌ Erro upload media:", e.message);
        return null;
    }
};

export const setupListeners = ({ sock, sessionId, companyId }) => {

    // 1. SINCRONIZAÇÃO DE HISTÓRICO (Carga Inicial)
    sock.ev.on('messaging-history.set', async ({ contacts, messages, isLatest }) => {
        console.log(`📚 [HISTORY] Processando lote. Contatos: ${contacts.length}, Msgs: ${messages.length}`);
        
        // Fase 1: Importar Contatos
        await updateInstanceStatus(sessionId, companyId, { sync_status: 'importing_contacts', sync_percent: 20 });
        for (const c of contacts) {
            await upsertContact({
                jid: c.id,
                companyId,
                name: c.name || c.notify || c.verifiedName,
                imgUrl: c.imgUrl,
                isFromAddressBook: true
            });
        }

        // Fase 2: Importar Mensagens
        await updateInstanceStatus(sessionId, companyId, { sync_status: 'importing_messages', sync_percent: 50 });
        
        // Filtra para pegar apenas as mais recentes se houver muitas (Otimização de memória)
        // Em produção, você pode querer processar todas em chunks.
        const msgsToProcess = messages.length > 500 ? messages.slice(-500) : messages;

        let processedCount = 0;
        for (const msg of msgsToProcess) {
            await processSingleMessage(msg, sock, companyId, sessionId, false); // false = não é realtime (sem webhook)
            processedCount++;
            
            // Atualiza barra a cada 50 mensagens
            if (processedCount % 50 === 0) {
                const percent = 50 + Math.floor((processedCount / msgsToProcess.length) * 40); // 50% a 90%
                await updateInstanceStatus(sessionId, companyId, { sync_percent: percent });
            }
        }

        if (isLatest) {
            console.log(`🏁 [HISTORY] Sincronização Totalmente Concluída.`);
            await updateInstanceStatus(sessionId, companyId, { sync_status: 'completed', sync_percent: 100 });
        }
    });

    // 2. MENSAGENS EM TEMPO REAL (Live)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // 'notify' significa nova mensagem real (não atualização de status)
        if (type !== 'notify') return;

        // Busca config de Webhook (Cachear isso seria ideal em alta escala)
        const { data: instanceConfig } = await supabase
            .from('instances')
            .select('webhook_url, webhook_enabled')
            .eq('session_id', sessionId)
            .single();

        for (const msg of messages) {
            // Ignora msgs de protocolo sem conteúdo
            if (!msg.message) continue;
            
            // Deduplicação em memória
            if (msgCache.has(msg.key.id)) continue;
            msgCache.add(msg.key.id);
            // Limpa cache após 10s
            setTimeout(() => msgCache.delete(msg.key.id), 10000);

            // Processa (Salva no Banco + Cria Lead se necessário)
            const processedMsg = await processSingleMessage(msg, sock, companyId, sessionId, true);

            // DISPARO DE WEBHOOK (n8n/Typebot)
            if (processedMsg && instanceConfig?.webhook_enabled && instanceConfig?.webhook_url) {
                // Não enviamos status broadcast para webhook de negócio
                if (msg.key.remoteJid !== 'status@broadcast') {
                    dispatchWebhook(instanceConfig.webhook_url, 'message.upsert', {
                        ...processedMsg,
                        instanceId: sessionId
                    });
                }
            }
        }
    });

    // 3. ATUALIZAÇÃO DE CONTATOS (Webhook do Baileys)
    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const c of contacts) {
            await upsertContact({
                jid: c.id,
                companyId,
                name: c.name || c.notify,
                imgUrl: c.imgUrl,
                isFromAddressBook: true
            });
        }
    });

    // 4. PRESENÇA (Online/Digitando)
    sock.ev.on('presence.update', async ({ id, presences }) => {
        const jid = normalizeJid(id);
        if (!jid) return;
        
        // Verifica se alguém está disponível ou digitando
        const isOnline = Object.values(presences).some(p => 
            p.lastKnownPresence === 'available' || p.lastKnownPresence === 'composing' || p.lastKnownPresence === 'recording'
        );

        if (isOnline) {
            await supabase.from('contacts')
                .update({ is_online: true, last_seen_at: new Date() })
                .eq('jid', jid)
                .eq('company_id', companyId);
        }
    });
    
    // 5. STATUS DE LEITURA (Ticks Azul/Cinza)
    sock.ev.on('message-receipt.update', async (events) => {
        for (const event of events) {
            // Mapeia status do Baileys para o Banco
            const statusMap = { 3: 'delivered', 4: 'read', 5: 'played' };
            const newStatus = statusMap[event.receipt.status];
            
            if (newStatus) {
                const updates = { status: newStatus };
                if (newStatus === 'read') updates.read_at = new Date();
                if (newStatus === 'delivered') updates.delivered_at = new Date();

                await supabase.from('messages')
                    .update(updates)
                    .eq('whatsapp_id', event.key.id)
                    .eq('company_id', companyId);
            }
        }
    });
};

// --- PROCESSADOR UNITÁRIO ---
async function processSingleMessage(rawMsg, sock, companyId, sessionId, isRealtime) {
    const msg = unwrapMessage(rawMsg);
    const remoteJid = normalizeJid(msg.key.remoteJid);
    
    // Filtros de segurança
    if (!remoteJid || remoteJid === 'status@broadcast') return null;

    const fromMe = msg.key.fromMe;
    const type = getContentType(msg.message);
    const body = getBody(msg.message);
    const pushName = msg.pushName;

    // Definição do Tipo
    let mediaUrl = null;
    let finalType = 'text';

    if (type === 'imageMessage') finalType = 'image';
    else if (type === 'videoMessage') finalType = 'video';
    else if (type === 'audioMessage') finalType = msg.message.audioMessage.ptt ? 'ptt' : 'audio';
    else if (type === 'documentMessage') finalType = 'document';
    else if (type === 'stickerMessage') finalType = 'sticker';
    else if (type === 'locationMessage') finalType = 'location';
    else if (type === 'contactMessage') finalType = 'contact';
    else if (type === 'pollCreationMessageV3' || type === 'pollCreationMessage') finalType = 'poll';

    // Download de Mídia (Apenas se for Realtime para economizar banda no histórico)
    if (isRealtime && ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(finalType)) {
        mediaUrl = await processMedia(msg, type);
    }

    // Normalização de Conteúdo Especial
    let content = body;
    if (finalType === 'poll') {
        const poll = msg.message.pollCreationMessageV3 || msg.message.pollCreationMessage;
        content = JSON.stringify({ 
            name: poll.name, 
            options: poll.options.map(o => o.optionName), 
            selectableOptionsCount: poll.selectableOptionsCount 
        });
    } else if (finalType === 'location') {
        const loc = msg.message.locationMessage;
        content = JSON.stringify({ latitude: loc.degreesLatitude, longitude: loc.degreesLongitude });
    } else if (finalType === 'contact') {
        const contact = msg.message.contactMessage;
        content = JSON.stringify({ displayName: contact.displayName, vcard: contact.vcard });
    }

    // Name Hunter: Se recebemos mensagem com pushName, atualizamos o contato
    if (!fromMe && pushName) {
        await upsertContact({ 
            jid: remoteJid, 
            companyId, 
            pushName: pushName,
            isFromAddressBook: false 
        });
    }

    // Criação de Lead Automática
    let leadId = null;
    if (!fromMe && !remoteJid.includes('@g.us')) {
        const phone = remoteJid.split('@')[0];
        // Ensure Lead verifica se já existe e retorna o ID. Se não existe, cria.
        leadId = await ensureLeadExists({ 
            companyId, 
            phone, 
            name: null,
            pushName 
        });
    }

    const messageData = {
        company_id: companyId,
        session_id: sessionId,
        remote_jid: remoteJid,
        whatsapp_id: msg.key.id,
        from_me: fromMe,
        content: content || (mediaUrl ? '' : body), // Se tem mídia, content pode ser vazio se não tiver legenda
        media_url: mediaUrl,
        message_type: finalType,
        status: fromMe ? 'sent' : 'received',
        created_at: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000),
        lead_id: leadId
    };

    // Salva no banco (Core do CRM)
    await upsertMessage(messageData);

    // Retorna objeto enriquecido para webhook
    return {
        ...messageData,
        pushName,
        isFromMe: fromMe,
        isGroup: remoteJid.includes('@g.us')
    };
}
