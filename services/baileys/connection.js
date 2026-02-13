
import makeWASocket, { 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    isJidBroadcast,
    proto
} from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from '../../auth/supabaseAuth.js';
import { setupListeners } from './listener.js';
import { deleteSessionData, updateInstanceStatus, normalizeJid } from '../crm/sync.js';
import { createClient } from "@supabase/supabase-js";
import getRedisClient from '../redisClient.js'; 
import pino from 'pino';
import { Logger } from '../../utils/logger.js'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const sessions = new Map();
const retries = new Map();

// Logs apenas de erros fatais para reduzir ruído
const logger = pino({ level: 'fatal' });

const subscribeToRecentChats = async (sock, companyId) => {
    try {
        const { data: recent } = await supabase
            .from('contacts')
            .select('jid')
            .eq('company_id', companyId)
            .eq('is_ignored', false)
            .order('last_message_at', { ascending: false })
            .limit(20);

        if (recent && recent.length > 0) {
            for (const contact of recent) {
                if (contact.jid.includes('@s.whatsapp.net')) {
                    await sock.presenceSubscribe(contact.jid);
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        }
    } catch (e) {
        Logger.warn('baileys', `Falha ao inscrever presença`, { error: e.message }, companyId);
    }
};

const checkIsBusiness = async (sock) => {
    try {
        const myJid = normalizeJid(sock.user?.id);
        if(!myJid) return false;
        const bizProfile = await sock.getBusinessProfile(myJid);
        return !!bizProfile;
    } catch (e) {
        return false;
    }
};

// Encerra forçadamente uma sessão em memória
const killSession = (sessionId) => {
    if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        try {
            session.sock.end(undefined); // Fecha socket
            session.sock.ws.close(); // Fecha WS
        } catch (e) {}
        sessions.delete(sessionId);
        console.log(`💀 [CONNECTION] Sessão ${sessionId} morta na memória.`);
    }
};

export const startSession = async (sessionId, companyId) => {
    // 1. Matar qualquer processo zumbi antes de iniciar
    killSession(sessionId);

    try {
        const { state, saveCreds } = await useSupabaseAuthState(sessionId);
        const { version } = await fetchLatestBaileysVersion();
        const redis = getRedisClient();

        console.log(`🔌 [CONNECTION] Iniciando sessão ${sessionId} (v${version.join('.')})`);

        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            msgRetryCounterCache: redis ? {
                get: async (key) => {
                    const result = await redis.get(`retry:${sessionId}:${key}`);
                    return result ? parseInt(result) : 0;
                },
                set: async (key, value) => {
                    await redis.set(`retry:${sessionId}:${key}`, value, 'EX', 60 * 60 * 24); 
                },
                del: async (key) => {
                    await redis.del(`retry:${sessionId}:${key}`);
                }
            } : undefined,
            browser: Browsers.ubuntu("Chrome"), 
            syncFullHistory: true, 
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 5000, 
            keepAliveIntervalMs: 30000, 
            shouldIgnoreJid: (jid) => isJidBroadcast(jid) || jid.includes('newsletter') || jid.includes('status@broadcast'),
            
            getMessage: async (key) => {
                if (!key.id) return null;
                try {
                    const { data: msg } = await supabase
                        .from('messages')
                        .select('content, message_type, media_url')
                        .eq('whatsapp_id', key.id)
                        .eq('company_id', companyId)
                        .maybeSingle();

                    if (!msg) return null;

                    let messagePayload = {};
                    
                    if (msg.message_type === 'text') {
                        messagePayload = { conversation: msg.content };
                    } else if (msg.message_type === 'image') {
                        messagePayload = { imageMessage: { caption: msg.content, url: msg.media_url } };
                    } else if (msg.message_type === 'poll') {
                         try {
                            const pollContent = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
                            const options = (pollContent.options || []).map(opt => ({ 
                                optionName: typeof opt === 'string' ? opt : (opt.optionName || 'Opção') 
                            }));
                            messagePayload = {
                                pollCreationMessageV3: {
                                    name: pollContent.name || 'Enquete',
                                    options: options,
                                    selectableOptionsCount: Number(pollContent.selectableOptionsCount) || 1
                                }
                            };
                        } catch (e) {}
                    } else {
                        messagePayload = { conversation: msg.content || '' };
                    }

                    return proto.Message.fromObject(messagePayload);
                } catch (e) {
                    return null;
                }
            }
        });

        sessions.set(sessionId, { sock, companyId });

        setupListeners({ sock, sessionId, companyId });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // DETECÇÃO DE ERRO CRÍTICO (Crypto Failure / Bad MAC / Conflict)
            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                const errorMsg = error?.message || '';

                console.log(`❌ [DESCONECTADO] ${sessionId}. Code: ${statusCode}. Msg: ${errorMsg}`);

                const isCryptoError = errorMsg.includes('authenticate data') || errorMsg.includes('Signal') || errorMsg.includes('Bad MAC');
                // Conflict (408, 440, 515)
                const isConflict = errorMsg.includes('Stream Errored (conflict)') || statusCode === 440 || statusCode === 515;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 403;

                // Se for logout ou erro de cripto IRRECUPERÁVEL, deleta a sessão
                if (isLoggedOut || (isCryptoError && !isConflict)) {
                    Logger.fatal('baileys', `Sessão encerrada permanentemente (${isCryptoError ? 'Erro Criptografia' : 'Logout'}).`, { sessionId, error: errorMsg }, companyId);
                    await deleteSession(sessionId, companyId);
                    return; 
                }

                // Se for conflito, adiciona delay grande E ALEATÓRIO (Jitter) para quebrar o ciclo
                if (isConflict) {
                     // Gera um delay aleatório entre 15s e 30s
                     const jitter = Math.floor(Math.random() * (30000 - 15000 + 1) + 15000);
                     
                     console.warn(`⚠️ [CONFLICT] Conflito de stream detectado para ${sessionId}. Reiniciando com Jitter de ${jitter}ms.`);
                     Logger.warn('baileys', `Conflito de Stream. Aguardando ${jitter}ms.`, { sessionId }, companyId);
                     
                     killSession(sessionId); 
                     handleReconnect(sessionId, companyId, jitter); 
                     return;
                }

                // Reconexão Padrão
                handleReconnect(sessionId, companyId, 0);
            }

            if (qr) {
                await updateInstanceStatus(sessionId, companyId, { 
                    status: 'qrcode', 
                    qrcode_url: qr,
                    sync_status: 'waiting',
                    sync_percent: 0
                });
            }

            if (connection === 'open') {
                console.log(`✅ [CONECTADO] Sessão ${sessionId} online!`);
                retries.delete(sessionId); 
                
                const isBiz = await checkIsBusiness(sock);
                
                const { data: prev } = await supabase
                    .from('instances')
                    .select('sync_status')
                    .eq('session_id', sessionId)
                    .single();

                const updatePayload = {
                    status: 'connected',
                    qrcode_url: null,
                    profile_pic_url: sock.user?.imgUrl || null,
                    is_business_account: isBiz
                };

                if (prev?.sync_status !== 'completed') {
                    updatePayload.sync_status = 'importing_contacts';
                    updatePayload.sync_percent = 5;
                }

                await updateInstanceStatus(sessionId, companyId, updatePayload);
                setTimeout(() => subscribeToRecentChats(sock, companyId), 5000);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        return sock;

    } catch (error) {
        Logger.fatal('baileys', `Falha crítica ao iniciar sessão`, { sessionId, error: error.message, stack: error.stack }, companyId);
        handleReconnect(sessionId, companyId, 5000);
    }
};

const handleReconnect = (sessionId, companyId, extraDelay = 0) => {
    const attempt = (retries.get(sessionId) || 0) + 1;
    
    // Limite de 20 tentativas para evitar loop infinito eterno em casos de erro de infra
    if (attempt > 20) {
        Logger.error('baileys', `Limite de tentativas de reconexão excedido. Parando.`, { sessionId }, companyId);
        retries.delete(sessionId);
        updateInstanceStatus(sessionId, companyId, { status: 'disconnected' });
        return;
    }

    retries.set(sessionId, attempt);
    // Exponential Backoff: 2s, 4s, 8s, 16s... até 60s
    // Se tiver extraDelay (Jitter de conflito), soma ele
    const delayMs = Math.min(Math.pow(2, attempt) * 1000, 60000) + extraDelay;
    
    console.log(`♻️ [RETRY] Reconectando ${sessionId} em ${delayMs}ms (Tentativa ${attempt})...`);
    setTimeout(() => startSession(sessionId, companyId), delayMs);
};

export const deleteSession = async (sessionId, companyId) => {
    killSession(sessionId);
    retries.delete(sessionId); 
    await deleteSessionData(sessionId, companyId);
};
