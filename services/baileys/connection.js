
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
import getRedisClient from '../redisClient.js'; // Redis para cache de retry
import pino from 'pino';
import { Logger } from '../../utils/logger.js'; // NOVO IMPORT

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
            // console.log(`👀 [PRESENCE] Inscrevendo em ${recent.length} chats recentes...`);
            for (const contact of recent) {
                if (contact.jid.includes('@s.whatsapp.net')) {
                    await sock.presenceSubscribe(contact.jid);
                    // Delay minúsculo para não floodar o socket e evitar desconexão
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        }
    } catch (e) {
        Logger.warn('baileys', `Falha ao inscrever presença`, { error: e.message }, companyId);
    }
};

// Verifica se a própria instância é Business
const checkIsBusiness = async (sock) => {
    try {
        // Tenta obter o perfil de business do próprio JID
        const myJid = normalizeJid(sock.user?.id);
        if(!myJid) return false;
        
        // Se retornar dados, é business. Se der 404, é pessoal.
        const bizProfile = await sock.getBusinessProfile(myJid);
        return !!bizProfile;
    } catch (e) {
        return false;
    }
};

export const startSession = async (sessionId, companyId) => {
    try {
        // 1. Recupera estado de autenticação do Banco
        const { state, saveCreds } = await useSupabaseAuthState(sessionId);
        const { version } = await fetchLatestBaileysVersion();
        const redis = getRedisClient();

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
            // PERSISTÊNCIA DE RETRY (Critical para restarts)
            msgRetryCounterCache: redis ? {
                get: async (key) => {
                    const result = await redis.get(`retry:${sessionId}:${key}`);
                    return result ? parseInt(result) : 0;
                },
                set: async (key, value) => {
                    await redis.set(`retry:${sessionId}:${key}`, value, 'EX', 60 * 60 * 24); // TTL 24h
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
            retryRequestDelayMs: 2500,
            keepAliveIntervalMs: 30000, 
            // IGNORE NEWSLETTERS AT ROOT LEVEL
            shouldIgnoreJid: (jid) => isJidBroadcast(jid) || jid.includes('newsletter') || jid.includes('status@broadcast'),
            
            // --- IMPLEMENTAÇÃO OBRIGATÓRIA DO MANUAL (getMessage) ---
            // Recupera mensagens antigas caso o outro lado solicite reenvio (Criptografia / Bad MAC Fix)
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
                        // Reconstrói Poll (Vital para Bad MAC em votos)
                        // A reconstrução deve ser PERFEITA para o hash bater
                        try {
                            const pollContent = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
                            
                            // Extração e normalização de opções para o formato Proto
                            // Se optionName não existir, usa a string direta (fallback)
                            const options = (pollContent.options || []).map(opt => ({ 
                                optionName: typeof opt === 'string' ? opt : (opt.optionName || 'Opção') 
                            }));
                            
                            // Baileys moderno usa pollCreationMessageV3 por padrão
                            // Importante: selectableOptionsCount deve ser número
                            messagePayload = {
                                pollCreationMessageV3: {
                                    name: pollContent.name || 'Enquete',
                                    options: options,
                                    selectableOptionsCount: Number(pollContent.selectableOptionsCount) || 1
                                }
                            };
                        } catch (e) {
                            Logger.error('baileys', 'Falha ao reconstruir enquete para retry', { error: e.message, key: key.id }, companyId);
                            messagePayload = { conversation: "[Enquete Corrompida]" };
                        }
                    } else {
                        // Fallback genérico
                        messagePayload = { conversation: msg.content || '' };
                    }

                    return proto.Message.fromObject(messagePayload);
                } catch (e) {
                    Logger.error('baileys', 'Falha crítica no getMessage', { error: e.message, key: key.id }, companyId);
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
                
                // Verifica se é Business (Audit)
                const isBiz = await checkIsBusiness(sock);
                
                // FIX RECONEXÃO: Verifica status anterior antes de forçar 'importing'
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

                // Se NÃO estava completo, reinicia o sync visual.
                // Se JÁ estava completo (reconexão), mantém como está e não reseta a %
                // Isso evita que o modal de loading apareça em reconexões simples.
                if (prev?.sync_status !== 'completed') {
                    updatePayload.sync_status = 'importing_contacts';
                    updatePayload.sync_percent = 5;
                }

                await updateInstanceStatus(sessionId, companyId, updatePayload);

                // ATIVAÇÃO DE PRESENÇA (FIX Visto Por Último)
                setTimeout(() => subscribeToRecentChats(sock, companyId), 5000);
            }

            // C) DESCONEXÃO
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 403;
                
                console.log(`❌ [DESCONECTADO] ${sessionId}. Code: ${statusCode}. Retry: ${shouldReconnect}`);

                if (!shouldReconnect) {
                    Logger.warn('baileys', `Sessão inválida ou logout. Limpando dados.`, { sessionId }, companyId);
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
        Logger.fatal('baileys', `Falha ao iniciar sessão`, { sessionId, error: error.message }, companyId);
        handleReconnect(sessionId, companyId);
    }
};

const handleReconnect = (sessionId, companyId) => {
    const attempt = (retries.get(sessionId) || 0) + 1;
    
    if (attempt > 10) {
        Logger.error('baileys', `Sessão falhou 10x. Desistindo da reconexão automática.`, { sessionId }, companyId);
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
