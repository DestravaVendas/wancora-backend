
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    delay
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import { useSupabaseAuthState, clearSessionCache } from '../../auth/supabaseAuth.js';
import { setupListeners } from './listener.js';
import { updateInstanceStatus, updateSyncStatus, deleteSessionData } from '../crm/sync.js';
import { recoverPendingMessages } from '../scheduler/sentinel.js';
import getRedisClient from '../redisClient.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
export const sessions = new Map();
const retries = new Map();

// 🛡️ CONFIGURAÇÕES DE ESTABILIDADE
const MAX_RETRIES = 5;
const RECONNECT_INTERVAL = 5000;
const WATCHDOG_INTERVAL = 60000; // 1 minuto

/**
 * 🛡️ WATCHDOG: Monitora a saúde das sessões e detecta estados "zumbis"
 */
setInterval(async () => {
    for (const [sessionId, session] of sessions.entries()) {
        try {
            const now = Date.now();
            const lastActivity = session.lastActivity || 0;
            const isStuck = (now - lastActivity > 300000) && session.status === 'connected';

            if (isStuck) {
                console.warn(`⚠️ [WATCHDOG] Sessão ${sessionId} parece travada (Sem atividade > 5min). Reiniciando...`);
                await killSession(sessionId);
                startSession(sessionId, session.companyId);
            }
        } catch (e) {}
    }
}, WATCHDOG_INTERVAL);

export const startSession = async (sessionId, companyId) => {
    if (sessions.has(sessionId)) return sessions.get(sessionId);

    console.log(`🚀 [BAILEYS] Iniciando sessão: ${sessionId}`);
    
    try {
        const { state, saveCreds } = await useSupabaseAuthState(sessionId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            browser: Browsers.ubuntu("Chrome"),
            syncFullHistory: true,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            generateHighQualityLinkPreview: true,
            getMessage: async (key) => {
                // Recuperação de mensagens para retry nativo do Baileys
                const { data } = await supabase.from('messages')
                    .select('content')
                    .eq('whatsapp_id', key.id)
                    .maybeSingle();
                return data ? { conversation: data.content } : undefined;
            }
        });

        const session = {
            sock,
            sessionId,
            companyId,
            status: 'connecting',
            lastActivity: Date.now()
        };

        sessions.set(sessionId, session);

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            session.lastActivity = Date.now();

            if (qr) {
                console.log(`[QR] Nova tentativa para ${sessionId}`);
                await updateInstanceStatus(sessionId, companyId, { status: 'qrcode', qrcode_url: qr });
            }

            if (connection === 'open') {
                console.log(`✅ [BAILEYS] Conectado: ${sessionId}`);
                sessions.get(sessionId).status = 'connected';
                retries.delete(sessionId);
                
                await updateInstanceStatus(sessionId, companyId, { status: 'connected', qrcode_url: null });
                recoverPendingMessages(companyId).catch(() => {});
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`❌ [BAILEYS] Conexão fechada (${sessionId}). Razão: ${statusCode}`);

                if (shouldReconnect) {
                    handleReconnect(sessionId, companyId, statusCode);
                } else {
                    console.error(`🚫 [BAILEYS] Logout detectado para ${sessionId}`);
                    await deleteSession(sessionId, companyId);
                }
            }
        });

        setupListeners({ sock, sessionId, companyId });
        return session;

    } catch (error) {
        console.error(`❌ [BAILEYS] Falha ao iniciar sessão ${sessionId}:`, error.message);
        return null;
    }
};

const handleReconnect = async (sessionId, companyId, reason) => {
    const retryCount = retries.get(sessionId) || 0;

    // 🛡️ AUTO-REPARO DE CRIPTOGRAFIA (Bad MAC / Signal)
    if (reason === 411 || reason === 401) {
        console.warn(`🛠️ [REPARO] Erro de integridade detectado. Limpando chaves de sessão...`);
        // Limpa apenas as chaves, mantém os creds (Tenta salvar a sessão)
        await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId).neq('data_type', 'creds');
    }

    if (retryCount < MAX_RETRIES) {
        retries.set(sessionId, retryCount + 1);
        const delayMs = RECONNECT_INTERVAL * Math.pow(2, retryCount);
        console.log(`🔄 [RECONNECT] Tentativa ${retryCount + 1} em ${delayMs}ms...`);
        
        setTimeout(() => {
            sessions.delete(sessionId);
            startSession(sessionId, companyId);
        }, delayMs);
    } else {
        console.error(`💀 [BAILEYS] Máximo de tentativas atingido para ${sessionId}`);
        await updateInstanceStatus(sessionId, companyId, { status: 'disconnected' });
    }
};

export const killSession = async (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
        try {
            session.sock.ev.removeAllListeners();
            session.sock.terminate();
        } catch (e) {}
        sessions.delete(sessionId);
        clearSessionCache(sessionId);
    }
};

export const deleteSession = async (sessionId, companyId) => {
    await killSession(sessionId);
    await deleteSessionData(sessionId, companyId);
};
