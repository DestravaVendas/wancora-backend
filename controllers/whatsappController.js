// controllers/whatsappController.js
import makeWASocket, { 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    delay,
    downloadMediaMessage,
    getContentType
} from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import mime from "mime-types";

// CHECAGEM DE SEGURANÇA
if (!process.env.SUPABASE_KEY || !process.env.SUPABASE_URL) {
    console.error("❌ ERRO FATAL: Chaves do Supabase não encontradas no .env");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// GESTÃO DE ESTADO EM MEMÓRIA (RAM)
const sessions = new Map();       
const companyIndex = new Map();   
const retries = new Map(); 
const reconnectTimers = new Map();       
const lastQrUpdate = new Map();
const contactCache = new Set(); // Cache para evitar SPAM de upsert de contatos
const leadCreationLock = new Set(); // Mutex para evitar duplicidade de Leads em rajadas

// --- HELPER: Unwrap Message (Desenrola mensagens temporárias/visualização única) ---
// CORREÇÃO CRÍTICA: Expandido para cobrir documentsWithCaption e V2
const unwrapMessage = (msg) => {
    if (!msg.message) return msg;
    
    let content = msg.message;
    
    // Desenrola Ephemeral (Mensagens temporárias)
    if (content.ephemeralMessage) {
        content = content.ephemeralMessage.message;
    }
    // Desenrola ViewOnce (Visualização única V1)
    if (content.viewOnceMessage) {
        content = content.viewOnceMessage.message;
    }
    // Desenrola ViewOnceV2 (Visualização única V2 - comum em áudios/vídeos novos)
    if (content.viewOnceMessageV2) {
        content = content.viewOnceMessageV2.message;
    }
    // Desenrola Documentos com Legenda (Novo formato WhatsApp)
    if (content.documentWithCaptionMessage) {
        content = content.documentWithCaptionMessage.message;
    }
    // Desenrola Mensagens Editadas
    if (content.editedMessage) {
        content = content.editedMessage.message.protocolMessage.editedMessage;
    }

    return { ...msg, message: content };
};

// --- HELPER: Upload de Mídia com Retry ---
const uploadMediaToSupabase = async (buffer, type) => {
    try {
        const fileExt = mime.extension(type) || 'bin';
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `chat-media/${fileName}`;

        const { error } = await supabase.storage
            .from('chat-media')
            .upload(filePath, buffer, { contentType: type, upsert: false });

        if (error) throw error;

        const { data } = supabase.storage.from('chat-media').getPublicUrl(filePath);
        return data.publicUrl;
    } catch (err) {
        console.error('❌ Erro upload media:', err.message);
        return null;
    }
};

// --- HELPER: Atualização Inteligente de Nome (Hierarquia) ---
// Prioridade: 1. Agenda (contacts.name) > 2. Perfil (pushName) > 3. Número
const smartUpdateLeadName = async (phone, pushName, companyId) => {
    try {
        // 1. Busca dados atuais do Lead e do Contato
        const { data: lead } = await supabase
            .from('leads')
            .select('id, name')
            .eq('phone', phone)
            .eq('company_id', companyId)
            .maybeSingle();

        if (!lead) return;

        // Busca se temos um nome salvo na agenda (tabela contacts)
        // O sufixo do JID é necessário para a busca
        const remoteJid = `${phone}@s.whatsapp.net`;
        const { data: contact } = await supabase
            .from('contacts')
            .select('name')
            .eq('jid', remoteJid)
            .eq('company_id', companyId)
            .maybeSingle();

        const savedName = contact?.name; // Nome salvo na agenda
        
        // Define o "Melhor Nome Disponível"
        const bestName = savedName || pushName;

        if (!bestName) return; // Se não tem nome nenhum melhor, aborta

        // Lógica de Proteção: Só atualiza se o nome atual no CRM for "Genérico" (número)
        const currentNameClean = lead.name.replace(/\D/g, '');
        const phoneClean = phone.replace(/\D/g, '');
        
        // Verifica se o nome atual é basicamente o número de telefone
        const isGenericName = currentNameClean.includes(phoneClean) || lead.name.startsWith('+') || lead.name === phone;

        // Se o nome atual é genérico E temos um nome melhor -> Atualiza
        if (isGenericName && lead.name !== bestName) {
            console.log(`✨ [SMART SYNC] Atualizando Lead ${phone}: "${lead.name}" -> "${bestName}"`);
            await supabase.from('leads').update({ name: bestName }).eq('id', lead.id);
        }

    } catch (e) {
        console.error("Erro no smartUpdateLeadName:", e);
    }
};

// --- HELPER: Anti-Ghost Inteligente (Com Mutex de Criação) ---
const ensureLeadExists = async (remoteJid, pushName, companyId) => {
    // 1. Ignora infraestrutura do WhatsApp
    if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us') || remoteJid.includes('@lid')) return null;
    
    const phone = remoteJid.split('@')[0];
    const lockKey = `${companyId}:${phone}`;

    // 2. Verifica se já estamos criando este lead AGORA (Mutex)
    if (leadCreationLock.has(lockKey)) {
        await delay(1000); 
        const { data: lead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
        return lead?.id || null;
    }

    try {
        leadCreationLock.add(lockKey); // 🔒 TRAVA

        // 3. Verifica Ignore List (Anti-Ghost) e Nome Salvo
        const { data: contact } = await supabase
            .from('contacts')
            .select('is_ignored, name')
            .eq('jid', remoteJid)
            .eq('company_id', companyId)
            .maybeSingle();

        if (contact && contact.is_ignored) {
            console.log(`🚫 [Anti-Ghost] Contato ${phone} ignorado.`);
            return null;
        }

        // 4. Verifica existência (Double Check)
        const { data: existingLead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
        if (existingLead) return existingLead.id;

        console.log(`🆕 [Anti-Ghost] Criando Lead para ${phone}...`);

        // 5. Definição de Nome Inicial (Agenda > PushName > Número)
        // Aqui usamos o nome do contato se existir, senão o pushname
        const finalName = contact?.name || pushName || `+${phone}`; 

        // 6. Pipeline Padrão
        const { data: firstStage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();
        
        const stageId = firstStage?.id || null;

        // 7. Inserção Atômica
        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            name: finalName,
            phone: phone,
            status: 'new',
            pipeline_stage_id: stageId 
        }).select('id').single();

        return newLead?.id || null;

    } catch (e) {
        console.error("Erro ensureLeadExists:", e);
        return null;
    } finally {
        leadCreationLock.delete(lockKey); // 🔓 DESTRAVA
    }
};

// --- HELPER: Upsert Contato (Otimizado) ---
const upsertContact = async (jid, sock, pushName = null, companyId = null, savedName = null, imgUrl = null) => {
    try {
        let suffix = '@s.whatsapp.net';
        if (jid.includes('@g.us')) suffix = '@g.us';
        if (jid.includes('@lid')) suffix = '@lid';

        const cleanJid = jid.split(':')[0] + suffix;
        const cacheKey = `${companyId}:${cleanJid}`;
        
        // Cache Check: Se já processamos recentemente E não há dados novos vitais, pula
        const hasNewInfo = pushName || savedName || imgUrl;
        if (contactCache.has(cacheKey) && !hasNewInfo) return; 

        const contactData = { jid: cleanJid, company_id: companyId, updated_at: new Date() };
        if (savedName) contactData.name = savedName; 
        if (pushName) contactData.push_name = pushName;
        if (imgUrl) contactData.profile_pic_url = imgUrl;

        const { error } = await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
        
        if (!error) {
            contactCache.add(cacheKey);
            setTimeout(() => contactCache.delete(cacheKey), 10 * 60 * 1000);
        }
    } catch (e) {
        // Silencioso para não poluir logs
    }
};

// --- HELPER: Extração de Conteúdo Robusta ---
const getMessageContent = (msg) => {
    if (!msg) return "";
    // Ordem de prioridade importa
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.caption) return msg.documentMessage.caption;
    if (msg.templateButtonReplyMessage?.selectedId) return msg.templateButtonReplyMessage.selectedId;
    if (msg.buttonsResponseMessage?.selectedButtonId) return msg.buttonsResponseMessage.selectedButtonId;
    if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) return msg.listResponseMessage.singleSelectReply.selectedRowId;
    return "";
};

const getMessageType = (msg) => {
    if (msg.imageMessage) return 'image';
    if (msg.audioMessage) return 'audio'; 
    if (msg.videoMessage) return 'video';
    if (msg.documentMessage) return 'document';
    if (msg.stickerMessage) return 'sticker';
    if (msg.pollCreationMessage || msg.pollCreationMessageV3) return 'poll';
    if (msg.locationMessage) return 'location';
    if (msg.contactMessage) return 'contact';
    return 'text';
};

// ==============================================================================
// CORE: START SESSION
// ==============================================================================
export const startSession = async (sessionId, companyId) => {
    console.log(`[START] Sessão ${sessionId} (Empresa: ${companyId})`);
    
    if (sessions.has(sessionId)) {
        await deleteSession(sessionId, companyId, false);
    }

    const { state, saveCreds } = await useSupabaseAuthState(sessionId);
    let version = [2, 3000, 1015901307];
    try { const v = await fetchLatestBaileysVersion(); version = v.version; } catch (e) {}

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        // FINGERPRINT OTIMIZADO PARA SERVIDOR (Evita banimento e loops)
        browser: ["Wancora CRM", "Ubuntu", "24.04"], 
        syncFullHistory: true, 
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            return { conversation: 'hello' }; 
        }
    });

    sock.companyId = companyId;
    sessions.set(sessionId, sock); 
    if (companyId) companyIndex.set(companyId, sessionId);

    sock.ev.on("creds.update", saveCreds);

    // --- 1. HISTÓRICO INTELIGENTE (SMART SYNC) ---
    sock.ev.on('messaging-history.set', async ({ contacts, messages }) => {
        console.log(`📚 [HISTÓRICO] Recebido. Contatos: ${contacts.length}, Msgs Brutas: ${messages.length}`);

        // A. Salvar Contatos
        const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net'));
        if (validContacts.length > 0) {
            const batch = validContacts.map(c => ({
                jid: c.id,
                name: c.name || c.verifiedName || null,
                push_name: c.notify || null,
                company_id: companyId,
                updated_at: new Date()
            }));
            await supabase.from('contacts').upsert(batch, { onConflict: 'jid' });
        }

        // B. Filtragem e Processamento
        const messagesByChat = new Map();
        messages.forEach(msg => {
            // Unwrapping aqui é importante para o histórico também
            const unwrapped = unwrapMessage(msg);
            const jid = unwrapped.key.remoteJid;
            if (!messagesByChat.has(jid)) messagesByChat.set(jid, []);
            messagesByChat.get(jid).push(unwrapped);
        });

        const smartMessages = [];
        const MSG_LIMIT_PER_CHAT = 20; // Aumentado ligeiramente para melhor contexto

        messagesByChat.forEach((chatMsgs, jid) => {
            // Ordena cronologicamente
            chatMsgs.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
            // Pega as últimas X
            const topMessages = chatMsgs.slice(-MSG_LIMIT_PER_CHAT);
            smartMessages.push(...topMessages);
        });

        console.log(`🧠 [SMART SYNC] Processando ${smartMessages.length} mensagens recentes.`);

        // C. Chunk Processing
        const CHUNK_SIZE = 50; 
        for (let i = 0; i < smartMessages.length; i += CHUNK_SIZE) {
            const chunk = smartMessages.slice(i, i + CHUNK_SIZE);
            // Processa sem baixar mídia antiga para economizar recursos
            await Promise.all(chunk.map(msg => processMessage(msg, sessionId, companyId, sock, false)));
            await delay(50);
        }
        
        console.log(`✅ [HISTÓRICO] Sync Completo.`);
    });

    // --- 2. CONTATOS ---
    sock.ev.on("contacts.upsert", async (contacts) => {
        const validContacts = contacts.filter(c => c.id.endsWith('@s.whatsapp.net'));
        if (validContacts.length > 0) {
            const batch = validContacts.map(c => ({
                jid: c.id,
                name: c.name || c.verifiedName || null,
                push_name: c.notify || null,
                company_id: companyId,
                updated_at: new Date()
            }));
            await supabase.from('contacts').upsert(batch, { onConflict: 'jid' });
        }
    });

    // --- 3. GRUPOS ---
    sock.ev.on("groups.update", async (groups) => {
        for (const g of groups) {
            if (g.subject) await upsertContact(g.id, sock, null, companyId, g.subject);
        }
    });

    // --- 4. CONEXÃO ---
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (!sessions.has(sessionId)) return; 

        if (connection) console.log(`🔌 [CONN] ${sessionId}: ${connection}`);

        if (qr) {
            const now = Date.now();
            const lastTime = lastQrUpdate.get(sessionId) || 0;
            // Throttle de atualização do QR Code (800ms)
            if (now - lastTime > 800) {
                lastQrUpdate.set(sessionId, now);
                await supabase.from("instances").update({ qrcode_url: qr, status: "qrcode", updated_at: new Date() }).eq('session_id', sessionId);
            }
        }

        if (connection === "close") {
            lastQrUpdate.delete(sessionId);
            if (reconnectTimers.has(sessionId)) { clearTimeout(reconnectTimers.get(sessionId)); reconnectTimers.delete(sessionId); }

            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode === 401 || statusCode === 403) {
                 await deleteSession(sessionId, companyId, true);
                 return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && sessions.has(sessionId)) {
                await supabase.from("instances").update({ status: "disconnected" }).eq("session_id", sessionId);
                
                // Exponential Backoff limitado
                const attempt = (retries.get(sessionId) || 0) + 1;
                retries.set(sessionId, attempt);
                const delayMs = Math.min(attempt * 2000, 15000); // Max 15s
                
                const timeoutId = setTimeout(() => { 
                    if (sessions.has(sessionId)) startSession(sessionId, companyId); 
                }, delayMs);
                reconnectTimers.set(sessionId, timeoutId);
            } else {
                await deleteSession(sessionId, companyId, false);
            }
        }

        if (connection === "open") {
            retries.set(sessionId, 0);
            await supabase.from("instances").update({ status: "connected", qrcode_url: null, updated_at: new Date() }).eq("session_id", sessionId);
            // Pequeno delay para buscar a foto do perfil da própria instância
            setTimeout(async () => {
                 const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                 try { 
                     const myPic = await sock.profilePictureUrl(userJid, 'image'); 
                     if(myPic) await supabase.from("instances").update({ profile_pic_url: myPic }).eq("session_id", sessionId);
                 } catch(e){}
            }, 3000);
        }
    });

    // --- 5. RECEBIMENTO (REALTIME) ---
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!sessions.has(sessionId)) return;
        
        console.log(`📨 [REALTIME] Upsert ${type}. Qtd: ${messages.length}`);

        if (type === "notify" || type === "append") {
            for (const msg of messages) {
                // Desenrola mensagens temporárias ANTES de processar
                // CORREÇÃO: Isso garante que 'content' não seja vazio depois
                const cleanMsg = unwrapMessage(msg);
                await processMessage(cleanMsg, sessionId, companyId, sock, true);
            }
        }
    });

    return sock;
};

// --- PROCESSAMENTO PRINCIPAL ---
const processMessage = async (msg, sessionId, companyId, sock, shouldDownloadMedia = false) => {
    try {
        if (!msg.message) return;
        
        const remoteJid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const whatsappId = msg.key.id; 
        const pushName = msg.pushName;

        // Filtros de Ignorados
        if (remoteJid === 'status@broadcast') return; 
        if (remoteJid.includes('@broadcast')) return;

        // CORREÇÃO: Extração de conteúdo da mensagem JÁ DESENROLADA
        let content = getMessageContent(msg.message);
        let msgType = getMessageType(msg.message);
        let mediaUrl = null;

        // Ignora mensagens de protocolo vazias
        if (!content && msgType === 'text') {
            if (!msg.message.stickerMessage) return;
        }

        console.log(`⚡ [MSG] ${remoteJid} | Tipo: ${msgType} | FromMe: ${fromMe} | Content: ${content.slice(0, 20)}...`);

        // 1. Atualiza Contato (PushName é atualizado aqui)
        await upsertContact(remoteJid, sock, pushName, companyId);

        let leadId = null;
        if (!remoteJid.includes('@g.us')) {
            // 2. Garante Lead (com Mutex)
            leadId = await ensureLeadExists(remoteJid, pushName, companyId);
            
            // 3. ATUALIZAÇÃO INTELIGENTE DE NOME (Novo Recurso)
            // Tenta melhorar o nome do lead se for apenas um número
            if (!fromMe) {
                const phone = remoteJid.split('@')[0];
                await smartUpdateLeadName(phone, pushName, companyId);
            }
        }

        // 4. Download de Mídia Seguro
        const supportedTypes = ['image', 'video', 'audio', 'document', 'sticker'];
        if (shouldDownloadMedia && supportedTypes.includes(msgType)) {
            try {
                // Verificação de segurança de tamanho
                const specificMsg = msg.message[msgType + 'Message'] || msg.message;
                const fileSize = specificMsg?.fileLength;
                
                if (fileSize && Number(fileSize) > 50 * 1024 * 1024) {
                    console.warn(`⚠️ Mídia muito grande (${fileSize} bytes). Ignorando download.`);
                    content = `[Arquivo Grande > 50MB]`;
                } else {
                    console.log(`📥 [MEDIA] Baixando ${msgType}...`);
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    
                    let mimetype = 'application/octet-stream';
                    // Correção de Mime Types para compatibilidade HTML5
                    if (msg.message.imageMessage) mimetype = 'image/jpeg';
                    else if (msg.message.audioMessage) mimetype = 'audio/mp4'; 
                    else if (msg.message.videoMessage) mimetype = 'video/mp4';
                    else if (msg.message.documentMessage) mimetype = msg.message.documentMessage.mimetype;
                    else if (msg.message.stickerMessage) mimetype = 'image/webp';

                    mediaUrl = await uploadMediaToSupabase(buffer, mimetype);
                    console.log(`📤 [MEDIA] URL: ${mediaUrl}`);
                }
            } catch (mediaErr) {
                console.error('❌ [MEDIA] Erro download:', mediaErr.message);
                content = `[Erro no Download da Mídia]`;
            }
        }

        // 5. Parseamento de Enquete
        if (msgType === 'poll') {
            try {
                const pollData = msg.message.pollCreationMessage || msg.message.pollCreationMessageV3;
                if (pollData) {
                    content = JSON.stringify({
                        name: pollData.name,
                        options: pollData.options.map(o => o.optionName),
                        selectableOptionsCount: pollData.selectableOptionsCount
                    });
                }
            } catch(e) { content = 'Enquete'; }
        }

        // 6. Persistência
        const { error } = await supabase.from('messages').upsert({
            company_id: companyId,
            session_id: sessionId,
            remote_jid: remoteJid,
            whatsapp_id: whatsappId,
            from_me: fromMe,
            content: content || (mediaUrl ? '[Mídia]' : ''), // Garante que não salve string vazia se tiver mídia
            message_type: msgType,
            media_url: mediaUrl, 
            status: fromMe ? 'sent' : 'received',
            lead_id: leadId, 
            created_at: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date()
        }, { 
            onConflict: 'remote_jid, whatsapp_id'
        });

        if (error) console.error(`❌ [DB] Falha msg ${whatsappId}:`, error.message);

    } catch (e) {
        console.error("❌ [CRASH] Erro fatal processamento:", e);
    }
};

// --- ENVIO DE MENSAGENS ---
export const sendMessage = async (sessionId, to, payload) => {
    const sock = sessions.get(sessionId);
    if (!sock) throw new Error("Sessão não ativa");
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    let sentMsg;

    try {
        console.log(`[SEND] Para: ${jid} | Tipo: ${payload.type}`);

        switch (payload.type) {
            case 'text':
                if (payload.text && payload.text.startsWith('Chave Pix:')) {
                    sentMsg = await sock.sendMessage(jid, { text: payload.text });
                } else {
                    sentMsg = await sock.sendMessage(jid, { text: payload.content || payload.text || "" });
                }
                break;

            case 'image':
                sentMsg = await sock.sendMessage(jid, { 
                    image: { url: payload.url }, 
                    caption: payload.caption 
                });
                break;

            case 'video':
                sentMsg = await sock.sendMessage(jid, { 
                    video: { url: payload.url }, 
                    caption: payload.caption 
                });
                break;

            case 'audio':
                const isPtt = payload.ptt === true; 
                sentMsg = await sock.sendMessage(jid, { 
                    audio: { url: payload.url }, 
                    mimetype: 'audio/mp4', // WhatsApp requer mp4 para áudio
                    ptt: isPtt 
                });
                break;

            case 'document':
                sentMsg = await sock.sendMessage(jid, { 
                    document: { url: payload.url }, 
                    mimetype: payload.mimetype || 'application/pdf',
                    fileName: payload.fileName || 'documento'
                });
                break;

            case 'poll':
                if (!payload.poll || !payload.poll.options || payload.poll.options.length < 2) {
                    throw new Error("Enquete precisa de pelo menos 2 opções.");
                }
                sentMsg = await sock.sendMessage(jid, {
                    poll: {
                        name: payload.poll.name,
                        values: payload.poll.options, 
                        selectableCount: payload.poll.selectableOptionsCount || 1
                    }
                });
                break;

            case 'location':
                sentMsg = await sock.sendMessage(jid, {
                    location: {
                        degreesLatitude: payload.location.latitude,
                        degreesLongitude: payload.location.longitude
                    }
                });
                break;

            case 'contact':
                sentMsg = await sock.sendMessage(jid, {
                    contacts: {
                        displayName: payload.contact.displayName,
                        contacts: [{ vcard: payload.contact.vcard }]
                    }
                });
                break;

            default:
                sentMsg = await sock.sendMessage(jid, { text: payload.text || payload.content || "" });
        }

        return sentMsg;
    } catch (err) {
        console.error("❌ Erro no envio:", err);
        throw err;
    }
};

export const deleteSession = async (sessionId, companyId, clearDb = true) => {
    console.log(`[DELETE] Sessão ${sessionId}`);
    if (companyId) companyIndex.delete(companyId);
    
    lastQrUpdate.delete(sessionId);
    if (reconnectTimers.has(sessionId)) { clearTimeout(reconnectTimers.get(sessionId)); reconnectTimers.delete(sessionId); }

    const sock = sessions.get(sessionId);
    sessions.delete(sessionId);
    retries.delete(sessionId);
    
    if (sock) { 
        try { 
            sock.ev.removeAllListeners("connection.update");
            sock.ev.removeAllListeners("creds.update");
            sock.ev.removeAllListeners("messages.upsert");
            sock.ev.removeAllListeners("messaging-history.set");
            sock.ev.removeAllListeners("contacts.upsert");
            sock.end(undefined); 
        } catch (e) {} 
    }

    if (clearDb) {
        await supabase.from("instances").delete().eq("session_id", sessionId);
        await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);
    }
    return true;
};

export const getSessionId = (companyId) => companyIndex.get(companyId);
export const getSession = (companyId) => {
    const sessionId = companyIndex.get(companyId);
    return sessionId ? sessions.get(sessionId) : null;
};
