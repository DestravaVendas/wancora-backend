
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

// Helper para forçar atualização de presença dos chats recentes
const subscribeToRecentChats = async (sock, companyId) => {
    try {
        // Busca os 20 chats mais recentes para se inscrever na presença
        const { data: recent } = await supabase
            .from('contacts')
            .select('jid')
            .eq('company_id', companyId)
            .eq('is_ignored', false)
            .order('last_message_at', { ascending: false })
            .limit(20);

        if (recent && recent.length > 0) {
            console.log(`👀 [PRESENCE] Inscrevendo em ${recent.length} chats recentes...`);
            for (const contact of recent) {
                if (contact.jid.includes('@s.whatsapp.net')) {
                    await sock.presenceSubscribe(contact.jid);
                    // Delay minúsculo para não floodar o socket e evitar desconexão
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        }
    } catch (e) {
        console.warn(`⚠️ [PRESENCE] Falha ao inscrever:`, e.message);
    }
};

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
                // Isso reduz IO e evita que o bot bata no banco a cada mensagem recebida.
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: Browsers.ubuntu("Chrome"), 
            syncFullHistory: true, 
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 2500,
            keepAliveIntervalMs: 30000, 
            // IGNORE NEWSLETTERS AT ROOT LEVEL
            shouldIgnoreJid: (jid) => isJidBroadcast(jid) || jid.includes('newsletter') || jid.includes('status@broadcast'),
            
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

                // ATIVAÇÃO DE PRESENÇA (FIX Visto Por Último)
                // Espera 5s para garantir que a conexão está estável antes de floodar com subscribes
                setTimeout(() => subscribeToRecentChats(sock, companyId), 5000);
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
