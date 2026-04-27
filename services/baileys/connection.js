
import makeWASocket, { 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    isJidBroadcast,
    proto
} from '@whiskeysockets/baileys';
import { useSupabaseAuthState, clearSessionCache } from '../../auth/supabaseAuth.js';
import { setupListeners } from './listener.js';
import { deleteSessionData, updateInstanceStatus, normalizeJid } from '../crm/sync.js';
import { createClient } from "@supabase/supabase-js";
import getRedisClient from '../redisClient.js'; 
import pino from 'pino';
import { Logger } from '../../utils/logger.js'; 
import { resetHistoryState } from './handlers/historyHandler.js'; // Import Vital

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const sessions = new Map();
const retries = new Map();
// 🔴 [ANTI-BAN] Sessões encerradas por logout (401/403 - loggedOut).
// O Watchdog NUNCA deve tentar reviver uma sessão neste Set (Hard Rule §12.3).
const bannedSessions = new Set();
const sessionLocks = new Map(); // 🛡️ [LOCK] Heartbeats das travas

const BOOT_DELAY = 60000; // 60s para garantir que instâncias antigas do Render morram

const logger = pino({ level: 'fatal' });

// 🛡️ [LOCK] Funções de Gerenciamento de Travas de Sessão (Evita Duplicidade)
const acquireLock = async (sessionId) => {
    const redis = getRedisClient();
    if (!redis) return true; // Se não tem redis, ignora (risco de duplicidade)
    const lockKey = `lock:session:${sessionId}`;
    // Tenta adquirir a trava por 45 segundos usando o PID do processo como valor
    const acquired = await redis.set(lockKey, process.pid, 'NX', 'PX', 45000);
    return acquired === 'OK';
};

const renewLock = async (sessionId) => {
    const redis = getRedisClient();
    if (!redis) return;
    const lockKey = `lock:session:${sessionId}`;
    await redis.pexpire(lockKey, 45000);
};

const releaseLock = async (sessionId) => {
    const redis = getRedisClient();
    if (!redis) return;
    const lockKey = `lock:session:${sessionId}`;
    const current = await redis.get(lockKey);
    if (current == process.pid) {
        await redis.del(lockKey);
    }
};

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

const killSession = async (sessionId) => {
    if (sessions.has(sessionId)) {
        console.log(`💀 [CONNECTION] Matando sessão ${sessionId} (Hard Kill)...`);
        
        // Limpa o Heartbeat do Lock
        if (sessionLocks.has(sessionId)) {
            clearInterval(sessionLocks.get(sessionId));
            sessionLocks.delete(sessionId);
        }
        await releaseLock(sessionId);

        const session = sessions.get(sessionId);
        try {
            // Remove listeners do Baileys
            if (session.sock && session.sock.ev) {
                session.sock.ev.removeAllListeners('connection.update');
                session.sock.ev.removeAllListeners('creds.update');
                session.sock.ev.removeAllListeners('messages.upsert');
            }
            
            // Encerra socket de forma segura
            session.sock.end(undefined);
            
            // Limpeza de WebSocket de baixo nível (Defensiva)
            if (session.sock.ws) {
                if (typeof session.sock.ws.removeAllListeners === 'function') {
                    session.sock.ws.removeAllListeners();
                }
                
                if (typeof session.sock.ws.terminate === 'function') {
                    session.sock.ws.terminate();
                } else if (typeof session.sock.ws.close === 'function') {
                    session.sock.ws.close();
                }
            }
        } catch (e) {
            console.error(`Erro ao matar sessão: ${e.message}`);
        }
        sessions.delete(sessionId);
        clearSessionCache(sessionId); // 🔥 LIMPA A MEMÓRIA RAM 
        // Limpa cache de histórico para evitar dados parciais na reconexão
        resetHistoryState(sessionId);
    }
};

// [NOVO] Monitoramento de Performance e Watchdog de Sessões
setInterval(async () => {
    const activeSessions = sessions.size;
    const redis = getRedisClient();
    const redisStatus = redis ? redis.status : 'not_configured';
    
    console.log(`📊 [WATCHDOG] Sessões em Memória: ${activeSessions} | Redis: ${redisStatus}`);

    try {
        // Busca sessões que deveriam estar conectadas no banco
        const { data: dbSessions } = await supabase
            .from('instances')
            .select('session_id, company_id, status, updated_at')
            .in('status', ['connected', 'connecting', 'qrcode']);

        if (dbSessions) {
            const now = Date.now();
            for (const dbSess of dbSessions) {
                const inMemory = sessions.get(dbSess.session_id);
                
                // 1. ZUMBI: Está no banco como conectado mas não está na memória do Node
                // 🔴 [BLOQUEIO ANTI-BAN] Sessões banidas (401/403) NUNCA são restauradas (Hard Rule §12.3)
                if (!inMemory && dbSess.status === 'connected') {
                    if (bannedSessions.has(dbSess.session_id)) {
                        console.warn(`🚫 [WATCHDOG] Sessão ${dbSess.session_id} está banida (logout). Ignorando restauração para proteger o IP.`);
                    } else {
                        console.warn(`🧟 [WATCHDOG] Detectada Sessão Zumbi: ${dbSess.session_id}. Restaurando...`);
                        startSession(dbSess.session_id, dbSess.company_id).catch(() => {});
                    }
                } 
                
                // 2. TRAVADA: Está em 'connecting' ou 'qrcode' há mais de 10 minutos sem atualização
                const lastUpdate = new Date(dbSess.updated_at).getTime();
                if (['connecting', 'qrcode'].includes(dbSess.status) && (now - lastUpdate > 600000)) {
                    console.warn(`⏳ [WATCHDOG] Sessão ${dbSess.session_id} travada em '${dbSess.status}'. Forçando reinício.`);
                    killSession(dbSess.session_id);
                    startSession(dbSess.session_id, dbSess.company_id).catch(() => {});
                }

                // 3. DESINCRONIZADO: Está na memória mas no banco diz que está desconectado (raro)
                if (inMemory && dbSess.status === 'disconnected') {
                     console.warn(`⚠️ [WATCHDOG] Sessão ${dbSess.session_id} ativa em memória mas 'disconnected' no banco. Sincronizando...`);
                     updateInstanceStatus(dbSess.session_id, dbSess.company_id, { status: 'connected' }).catch(() => {});
                }
            }
        }
    } catch (e) {
        console.error(`❌ [WATCHDOG] Erro ao verificar sessões zumbis:`, e.message);
    }
    
    if (activeSessions > 0) {
        // Alerta de performance se Redis estiver offline com carga
        if (activeSessions > 15 && redisStatus !== 'ready') {
            Logger.warn('baileys', `Carga alta (${activeSessions} sessões) sem Redis! Risco de instabilidade.`, { redisStatus });
        }
    }
}, 60000 * 2); // A cada 2 minutos

export const startSession = async (sessionId, companyId) => {
    const existing = sessions.get(sessionId);
    if (existing && existing.sock?.ws?.isOpen) {
        console.log(`⚡ [CONNECTION] Sessão ${sessionId} já está online. Ignorando restart.`);
        return existing.sock;
    }

    // 🛡️ [LOCK] Tenta adquirir a trava antes de iniciar
    const locked = await acquireLock(sessionId);
    if (!locked) {
        console.warn(`🚫 [CONNECTION] Sessão ${sessionId} já está ativa em outra instância. Abortando.`);
        return null;
    }

    await killSession(sessionId);
    await new Promise(r => setTimeout(r, 1000));

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
                // PERFORMANCE: Envolve as chaves em um cache de memória para reduzir I/O (§2.1)
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            // RESILIÊNCIA: Gerenciamento automático de sessões Signal degradadas pelo Baileys (§10.1)
            enableAutoSessionRecreation: true,
            msgRetryCounterCache: redis ? {
                get: async (key) => {
                    const start = Date.now();
                    const result = await redis.get(`retry:${sessionId}:${key}`);
                    const duration = Date.now() - start;
                    if (duration > 100) {
                        console.warn(`⚠️ [PERF] Redis GET lento: ${duration}ms para chave ${key}`);
                    }
                    return result ? parseInt(result) : 0;
                },
                set: async (key, value) => {
                    await redis.set(`retry:${sessionId}:${key}`, value, 'EX', 60 * 60 * 24); 
                },
                del: async (key) => {
                    await redis.del(`retry:${sessionId}:${key}`);
                }
            } : undefined,
            // ANTI-BAN: Simula navegador Desktop real (Mandatório macOS para stealth) (§2.1 + §18)
            browser: Browsers.macOS("Desktop"), 
            syncFullHistory: true, 
            // ANTI-BAN: Comportamento humano — aparece online ao conectar (§2.1)
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            defaultQueryTimeoutMs: 90000, 
            // RESILIÊNCIA: Timeout de conexão para ambientes de nuvem (§2.1)
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 2500,
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

        // 🛡️ [HEARTBEAT] Mantém a trava ativa enquanto a sessão existir
        const lockInterval = setInterval(() => renewLock(sessionId), 20000);
        sessionLocks.set(sessionId, lockInterval);

        setupListeners({ sock, sessionId, companyId });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                const errorMsg = error?.message || '';

                console.log(`❌ [DESCONECTADO] ${sessionId}. Code: ${statusCode}. Msg: ${errorMsg}`);

                resetHistoryState(sessionId);

                const isCryptoError = errorMsg.includes('authenticate data') || errorMsg.includes('Signal') || errorMsg.includes('Bad MAC');
                const isConflict = errorMsg.includes('Stream Errored (conflict)') || statusCode === 440 || statusCode === 515 || statusCode === 428;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 403;

                // [REPARO] Se for erro de criptografia mas não for logout real, tentamos apenas reconectar
                // Deletar a sessão (deleteSession) obriga o usuário a ler o QR Code de novo.
                if (isLoggedOut) {
                    Logger.fatal('baileys', `Sessão encerrada permanentemente (Logout — 401/403). Protegendo IP contra reconexão.`, { sessionId, statusCode, error: errorMsg }, companyId);
                    // 🔴 [ANTI-BAN] Marca como banida ANTES de deletar para bloquear o Watchdog (Hard Rule §12.3)
                    bannedSessions.add(sessionId);
                    retries.delete(sessionId); // Zera retries para não tentar reconectar
                    await deleteSession(sessionId, companyId);
                    return; 
                }

                if (isCryptoError && !isConflict) {
                    Logger.error('baileys', `Erro de Criptografia (Bad MAC/Signal). Tentando reparar...`, { sessionId, error: errorMsg }, companyId);
                    killSession(sessionId);
                    handleReconnect(sessionId, companyId, 5000);
                    return;
                }

                if (isConflict) {
                     const isShortJitter = statusCode === 515 || statusCode === 428;
                     const jitter = isShortJitter 
                        ? Math.floor(Math.random() * (10000 - 5000 + 1) + 5000) 
                        : Math.floor(Math.random() * (30000 - 15000 + 1) + 15000); 
                     
                     Logger.warn('baileys', `Conflito/Erro de Stream (${statusCode}). Jitter: ${jitter}ms.`, { sessionId }, companyId);
                     
                     killSession(sessionId); 
                     handleReconnect(sessionId, companyId, jitter); 
                     return;
                }

                // FIX: Sempre libera a trava em memória e Redis antes de tentar reconectar
                killSession(sessionId);
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
                    name: sock.user?.name || sock.user?.verifiedName || null,
                    profile_pic_url: sock.user?.imgUrl || null,
                    is_business_account: isBiz
                };

                // Se já estava completo, mantém. Se não, reseta para importar.
                if (prev?.sync_status !== 'completed') {
                    updatePayload.sync_status = 'importing_contacts';
                    updatePayload.sync_percent = 5;
                }

                await updateInstanceStatus(sessionId, companyId, updatePayload);
                setTimeout(() => subscribeToRecentChats(sock, companyId), 8000);
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
    
    if (attempt > 20) {
        Logger.error('baileys', `Limite de tentativas de reconexão excedido. Parando.`, { sessionId }, companyId);
        retries.delete(sessionId);
        updateInstanceStatus(sessionId, companyId, { status: 'disconnected' });
        return;
    }

    retries.set(sessionId, attempt);
    const delayMs = Math.min(Math.pow(2, attempt) * 1000, 60000) + extraDelay;
    
    console.log(`♻️ [RETRY] Reconectando ${sessionId} em ${delayMs}ms (Tentativa ${attempt})...`);
    setTimeout(() => startSession(sessionId, companyId), delayMs);
};

export const generatePairingCode = async (sessionId, phone) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sock) throw new Error("Sessão não iniciada. Ligue a instância primeiro.");
    
    // Baileys exige que o telefone venha limpo, apenas código do país + numero
    let cleanPhone = String(phone).replace(/[^0-9]/g, '');
    
    try {
        const code = await session.sock.requestPairingCode(cleanPhone);
        return code;
    } catch (e) {
        throw new Error(`Erro Baileys ao solicitar código: ${e.message}`);
    }
};

/**
 * Encerra todas as sessões ativas (Graceful Shutdown)
 */
export const shutdownAllSessions = async () => {
    Logger.info('baileys', `🛑 [SHUTDOWN] Encerrando ${sessions.size} sessões ativas para evitar conflitos de deploy...`);
    const activeSessions = Array.from(sessions.keys());
    
    for (const sessionId of activeSessions) {
        try {
            killSession(sessionId);
            Logger.info('baileys', `Sessão encerrada: ${sessionId}`);
        } catch (e) {
            Logger.error('baileys', `Erro ao encerrar sessão: ${sessionId}`, { error: e.message });
        }
    }
    
    sessions.clear();
    retries.clear();
};

export const deleteSession = async (sessionId, companyId) => {
    killSession(sessionId);
    retries.delete(sessionId); 
    await deleteSessionData(sessionId, companyId);
};
