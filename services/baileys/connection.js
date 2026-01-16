import makeWASocket, { fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import { useSupabaseAuthState } from '../../auth/supabaseAuth.js';
import { setupListeners } from './listener.js';
import { deleteSessionData, updateInstance } from '../crm/sync.js';

export const sessions = new Map();
const retries = new Map();
const reconnectTimers = new Map();

const logger = pino({ level: 'silent' });

export const startSession = async (sessionId, companyId) => {
    console.log(`[START] Sessão ${sessionId} (Empresa: ${companyId})`);

    // Limpa sessão anterior da memória se existir
    if (sessions.has(sessionId)) {
        await deleteSession(sessionId);
    }

    const { state, saveCreds } = await useSupabaseAuthState(sessionId);
    
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
        printQRInTerminal: false, // OBRIGATÓRIO: false (pois salvamos no banco)
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        // CORREÇÃO PONTUAL: Usar Ubuntu resolve o Timeout 408 no Render
        browser: Browsers.ubuntu("Chrome"), 
        syncFullHistory: true, 
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        getMessage: async () => {
            return { conversation: 'hello' }; 
        }
    });

    sock.companyId = companyId;
    sock.sessionId = sessionId;
    sessions.set(sessionId, { sock, companyId });

    // Salva credenciais (tokens) sempre que atualizarem
    sock.ev.on("creds.update", saveCreds);

    // --- LISTENER DE CONEXÃO (Responsável pelo QR Code) ---
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // 1. SE RECEBER QR CODE, ATUALIZA O BANCO IMEDIATAMENTE
        if (qr) {
            console.log(`[QR CODE] Novo QR gerado para ${sessionId}`);
            // Usamos try/catch para evitar crash se a instância tiver sido deletada
            try {
                await updateInstance(sessionId, { 
                    qrcode_url: qr, 
                    status: 'qrcode',
                    updated_at: new Date()
                });
            } catch (e) {
                console.error("Erro ao salvar QR:", e.message);
            }
        }

        // 2. SE CONECTAR, LIMPA O QR CODE
        if (connection === "open") {
            console.log(`[CONECTADO] Sessão ${sessionId} online!`);
            retries.set(sessionId, 0);
            
            await updateInstance(sessionId, { 
                status: "connected", 
                qrcode_url: null, 
                updated_at: new Date() 
            });
            
            // Tenta atualizar foto de perfil (Opcional)
            try {
               const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
               const pic = await sock.profilePictureUrl(userJid, 'image');
               if(pic) await updateInstance(sessionId, { profile_pic_url: pic });
            } catch(e) {}
        }

        // 3. SE DESCONECTAR, TRATA RECONEXÃO
        if (connection === "close") {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`[DESCONECTADO] Código: ${statusCode}. Reconectar? ${shouldReconnect}`);
            
            if (!shouldReconnect) {
                // Logout real -> desconecta banco
                await updateInstance(sessionId, { status: "disconnected" });
            }

            if (shouldReconnect) {
                handleReconnect(sessionId, companyId);
            } else {
                // Logout real (pelo celular) -> Limpa tudo
                await deleteSession(sessionId);
                await deleteSessionData(sessionId);
            }
        }
    });

    // Inicia os listeners de mensagens (listener.js)
    setupListeners({
        sock,
        sessionId,
        companyId
    });

    return sock;
};

// Lógica de Reconexão (Backoff)
const handleReconnect = (sessionId, companyId) => {
    if (!sessions.has(sessionId)) return; 

    const attempt = (retries.get(sessionId) || 0) + 1;
    retries.set(sessionId, attempt);
    
    // Teto de 60s para evitar loops rápidos
    const delayMs = Math.min(attempt * 2000, 60000); 
    console.log(`🔄 [RETRY] ${sessionId} em ${delayMs}ms (Tentativa ${attempt})`);

    const timeoutId = setTimeout(() => {
        startSession(sessionId, companyId);
    }, delayMs);
    
    reconnectTimers.set(sessionId, timeoutId);
};

export const deleteSession = async (sessionId) => {
    console.log(`[DELETE] Parando sessão ${sessionId}`);
    
    if (reconnectTimers.has(sessionId)) {
        clearTimeout(reconnectTimers.get(sessionId));
        reconnectTimers.delete(sessionId);
    }
    retries.delete(sessionId);

    const session = sessions.get(sessionId);
    if (session?.sock) {
        try {
            session.sock.ev.removeAllListeners("connection.update");
            session.sock.ev.removeAllListeners("creds.update");
            session.sock.ev.removeAllListeners("messages.upsert");
            session.sock.end(undefined);
        } catch (e) {
            console.error(`Erro ao fechar socket:`, e.message);
        }
    }
    sessions.delete(sessionId);
};
