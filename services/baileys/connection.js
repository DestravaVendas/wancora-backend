
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
import pino from 'pino';

// Cliente para getMessage (Recuperação de falha de criptografia)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Mapa em memória para manter os sockets ativos
export const sessions = new Map();

// Mapa para gerenciar tentativas de reconexão (Backoff Exponencial)
const retries = new Map();

// 🔥 SILENCER PATCH: Define nível 'fatal' para ignorar logs de info/debug/warn do Baileys
const logger = pino({ level: 'fatal' });

export const startSession = async (sessionId, companyId) => {
    try {
        // 1. Recupera estado de autenticação do Banco
        const { state, saveCreds } = await useSupabaseAuthState(sessionId);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`🔌 [CONNECTION] Iniciando sessão ${sessionId} (v${version.join('.')}) - Empresa: ${companyId}`);

        // 2. Configuração do Socket (Blindagem Anti-Ban & Protocolo Manual v2.0)
        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                // 🚀 CACHE EM MEMÓRIA: Envolve o store do Supabase com um cache LRU.
                // Isso evita que o bot bata no banco a cada mensagem recebida para buscar chaves.
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: Browsers.ubuntu("Chrome"), 
            syncFullHistory: true, 
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 2500,
            keepAliveIntervalMs: 30000, // Aumentado para 30s para reduzir overhead
            shouldIgnoreJid: (jid) => isJidBroadcast(jid) || jid.includes('newsletter'),
            
            // --- IMPLEMENTAÇÃO OBRIGATÓRIA DO MANUAL (getMessage) ---
            // Recupera mensagens antigas caso o outro lado solicite reenvio (Criptografia)
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

                    // Reconstrói um payload compatível com Proto
                    let messagePayload = {};
                    
                    if (msg.message_type === 'text') {
                        messagePayload = { conversation: msg.content };
                    } else if (msg.message_type === 'image') {
                        messagePayload = { imageMessage: { caption: msg.content, url: msg.media_url } };
                    } else if (msg.message_type === 'poll') {
                        // Reconstrói Poll
                        try {
                            const pollContent = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
                            
                            // Extração de opções robusta
                            const options = (pollContent.options || []).map(opt => ({ 
                                optionName: typeof opt === 'string' ? opt : (opt.optionName || 'Opção') 
                            }));

                            messagePayload = {
                                pollCreationMessage: {
                                    name: pollContent.name || 'Enquete',
                                    options: options,
                                    selectableOptionsCount: pollContent.selectableOptionsCount || 1
                                }
                            };
                        } catch (e) {
                            messagePayload = { conversation: "[Enquete Corrompida]" };
                        }
                    } else {
                        // Fallback genérico
                        messagePayload = { conversation: msg.content || '' };
                    }

                    return proto.Message.fromObject(messagePayload);
                } catch (e) {
                    return null;
                }
            }
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
                retries.delete(sessionId); 
                
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
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 403;
                
                console.log(`❌ [DESCONECTADO] ${sessionId}. Code: ${statusCode}. Retry: ${shouldReconnect}`);

                if (!shouldReconnect) {
                    console.warn(`🔒 [SECURITY] Sessão inválida ou logout. Limpando dados...`);
                    await deleteSession(sessionId, companyId);
                    return; 
                }

                if (statusCode === 440) return; // Conflito de sessão, não reconecta auto

                handleReconnect(sessionId, companyId);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        return sock;

    } catch (error) {
        console.error(`🚨 [FATAL] Falha ao iniciar sessão ${sessionId}:`, error);
        handleReconnect(sessionId, companyId);
    }
};

const handleReconnect = (sessionId, companyId) => {
    const attempt = (retries.get(sessionId) || 0) + 1;
    
    if (attempt > 10) {
        console.error(`💀 [DEATH] Sessão ${sessionId} falhou 10x. Desistindo.`);
        retries.delete(sessionId);
        updateInstanceStatus(sessionId, companyId, { status: 'disconnected' });
        return;
    }

    retries.set(sessionId, attempt);
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
    retries.delete(sessionId); 
    await deleteSessionData(sessionId, companyId);
};
