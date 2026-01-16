
import makeWASocket, { fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import pino from 'pino';
import { useSupabaseAuthState } from './auth.js';
import { setupListeners } from './listener.js';
import { deleteSessionData, updateInstance, updateSyncStatus } from '../crm/sync.js'; // Adicionado updateSyncStatus

// Mapa Global de Sessões Ativas (Memória RAM)
export const sessions = new Map();
// Mapa de Retries (para reconexão)
const retries = new Map();
const reconnectTimers = new Map();

const logger = pino({ level: 'silent' });

/**
 * Inicia uma Sessão do Baileys
 */
export const startSession = async (sessionId, companyId) => {
    console.log(`[START] Sessão ${sessionId} (Empresa: ${companyId})`);

    // Limpa sessão anterior se existir na memória para evitar duplicatas
    if (sessions.has(sessionId)) {
        await deleteSession(sessionId);
    }

    const { state, saveCreds } = await useSupabaseAuthState(sessionId);
    
    // Tenta buscar versão mais recente, com fallback seguro para versão estável conhecida
    let version = [2, 3000, 1015901307];
    try { 
        const v = await fetchLatestBaileysVersion(); 
        version = v.version; 
    } catch (e) {
        console.warn('⚠️ Falha ao buscar versão do Baileys, usando fallback.');
    }

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        // Configuração de Navegador para reduzir risco de banimento e manter sessão estável
        browser: ["Wancora CRM", "Chrome", "120.0.0"], 
        syncFullHistory: true, // Vital para o Smart Sync e histórico inicial
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000, 
        retryRequestDelayMs: 500,
        // STUB OBRIGATÓRIO (NÃO É MOCK DE TESTE): 
        // Necessário para o Baileys não crashar ao receber respostas de mensagens que não estão na RAM.
        getMessage: async (key) => {
            return { conversation: 'hello' }; 
        }
    });

    // Injeta IDs no objeto socket para uso nos listeners
    sock.companyId = companyId;
    sock.sessionId = sessionId;

    // Salva na memória
    sessions.set(sessionId, { sock, companyId });

    // Configura Listeners (Passando sock e dependências)
    setupListeners({
        sock,
        sessionId,
        companyId,
        saveCreds,
        reconnectFn: () => handleReconnect(sessionId, companyId), // Função wrapper
        logger
    });

    return sock;
};

// Lógica de Reconexão Exponencial (Robustez)
const handleReconnect = (sessionId, companyId) => {
    if (!sessions.has(sessionId)) return; // Se foi deletada manualmente, não reconecta

    const attempt = (retries.get(sessionId) || 0) + 1;
    retries.set(sessionId, attempt);
    
    // Delay progressivo: 2s, 4s, 6s... até teto de 30s
    const delayMs = Math.min(attempt * 2000, 30000); 
    console.log(`🔄 [RETRY] ${sessionId} em ${delayMs}ms (Tentativa ${attempt})`);

    const timeoutId = setTimeout(() => {
        // Verifica novamente antes de iniciar
        startSession(sessionId, companyId);
    }, delayMs);
    
    reconnectTimers.set(sessionId, timeoutId);
};

/**
 * Encerra uma sessão
 */
export const deleteSession = async (sessionId) => {
    console.log(`[DELETE] Encerrando sessão ${sessionId}`);
    
    // Limpa timers
    if (reconnectTimers.has(sessionId)) {
        clearTimeout(reconnectTimers.get(sessionId));
        reconnectTimers.delete(sessionId);
    }
    retries.delete(sessionId);

    const session = sessions.get(sessionId);
    if (session?.sock) {
        try {
            // Remove listeners para evitar memory leaks
            session.sock.ev.removeAllListeners("connection.update");
            session.sock.ev.removeAllListeners("creds.update");
            session.sock.ev.removeAllListeners("messages.upsert");
            session.sock.end(undefined);
        } catch (e) {
            console.error(`Erro ao fechar socket ${sessionId}:`, e.message);
        }
    }
    sessions.delete(sessionId);
};
