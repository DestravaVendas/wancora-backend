
import makeWASocket, { 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    isJidBroadcast
} from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from '../../auth/supabaseAuth.js';
import { setupListeners } from './listener.js';
import { deleteSessionData, updateInstanceStatus } from '../crm/sync.js';
import pino from 'pino';

// Mapa em memória para manter os sockets ativos
export const sessions = new Map();

// Mapa para gerenciar tentativas de reconexão (Backoff Exponencial)
const retries = new Map();

const logger = pino({ level: 'silent' });

export const startSession = async (sessionId, companyId) => {
    try {
        // 1. Recupera estado de autenticação do Banco
        const { state, saveCreds } = await useSupabaseAuthState(sessionId);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`🔌 [CONNECTION] Iniciando sessão ${sessionId} (v${version.join('.')}) - Empresa: ${companyId}`);

        // 2. Configuração do Socket (Blindagem Anti-Ban)
        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: Browsers.ubuntu("Chrome"), 
            syncFullHistory: true, 
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 2500,
            keepAliveIntervalMs: 15000, 
            shouldIgnoreJid: (jid) => isJidBroadcast(jid) || jid.includes('newsletter'),
            getMessage: async (key) => { return { conversation: 'hello' }; }
        });

        sessions.set(sessionId, { sock, companyId });

        // 3. Inicializa Listeners
        setupListeners({ sock, sessionId, companyId });

        // 4. Gestão de Eventos
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // A) QR CODE
            if (qr) {
                console.log(`📡 [QR CODE] Novo QR gerado para ${sessionId}`);
                await updateInstanceStatus(sessionId, companyId, { 
                    status: 'qrcode', 
                    qrcode_url: qr,
                    sync_status: 'waiting',
                    sync_percent: 0
                });
            }

            // B) CONECTADO
            if (connection === 'open') {
                console.log(`✅ [CONECTADO] Sessão ${sessionId} online!`);
                retries.delete(sessionId); // Zera contador de erros ao conectar com sucesso
                
                await updateInstanceStatus(sessionId, companyId, { 
                    status: 'connected', 
                    qrcode_url: null, 
                    sync_status: 'importing_contacts', 
                    sync_percent: 5,
                    profile_pic_url: sock.user?.imgUrl || null
                });
            }

            // C) DESCONEXÃO
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                
                // Filtra erros fatais onde NÃO devemos reconectar
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut 
                    && statusCode !== 403 
                    && statusCode !== 440 
                    && statusCode !== 401;
                
                console.log(`❌ [DESCONECTADO] ${sessionId}. Code: ${statusCode}. Reconectar? ${shouldReconnect}`);

                if (shouldReconnect) {
                    handleReconnect(sessionId, companyId);
                } else {
                    if (statusCode === 440) console.warn(`⚠️ [CONFLITO] Sessão ${sessionId} substituída.`);
                    console.log(`🧹 [LOGOUT] Limpando dados da sessão ${sessionId}`);
                    await deleteSession(sessionId, companyId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        return sock;

    } catch (error) {
        console.error(`🚨 [FATAL] Falha ao iniciar sessão ${sessionId}:`, error);
        handleReconnect(sessionId, companyId);
    }
};

// Lógica de Reconexão Inteligente
const handleReconnect = (sessionId, companyId) => {
    const attempt = (retries.get(sessionId) || 0) + 1;
    retries.set(sessionId, attempt);

    // Backoff: 2s, 4s, 8s... até o teto de 60s
    const delayMs = Math.min(Math.pow(2, attempt) * 1000, 60000);
    
    console.log(`🔄 [RETRY] ${sessionId} em ${delayMs}ms (Tentativa ${attempt})`);

    setTimeout(() => startSession(sessionId, companyId), delayMs);
};

export const deleteSession = async (sessionId, companyId) => {
    const session = sessions.get(sessionId);
    if (session) {
        try {
            session.sock.ev.removeAllListeners("connection.update");
            session.sock.end(undefined);
        } catch(e) {}
        sessions.delete(sessionId);
    }
    retries.delete(sessionId); // Limpa histórico de tentativas
    await deleteSessionData(sessionId, companyId);
};
