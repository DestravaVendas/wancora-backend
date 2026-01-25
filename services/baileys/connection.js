
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
// Chave: sessionId, Valor: { sock, companyId }
export const sessions = new Map();

// Logger silencioso para produção (mude para 'info' ou 'debug' se precisar debugar o Baileys)
const logger = pino({ level: 'silent' });

export const startSession = async (sessionId, companyId) => {
    // 1. Recupera estado de autenticação do Banco (PostgreSQL)
    const { state, saveCreds } = await useSupabaseAuthState(sessionId);
    
    // Busca versão mais recente para evitar erro de "WhatsApp desatualizado"
    const { version } = await fetchLatestBaileysVersion();

    console.log(`🔌 [CONNECTION] Iniciando sessão ${sessionId} (v${version.join('.')}) - Empresa: ${companyId}`);

    // 2. Configuração do Socket (Blindagem Anti-Ban e Performance)
    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false, // QR vai para o banco, não terminal
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        // TRUQUE CRÍTICO: Mimetiza um Linux Desktop para maior estabilidade no Render
        // Isso evita o erro 408 Request Timeout durante o pareamento
        browser: Browsers.ubuntu("Chrome"), 
        
        // Configurações de Sync
        syncFullHistory: true, // Necessário para importar conversas antigas
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        
        // Timeouts generosos para evitar quedas em conexões lentas
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 2500,
        keepAliveIntervalMs: 15000, 
        
        // Ignora mensagens de status/stories para economizar banda e evitar lixo no banco
        shouldIgnoreJid: (jid) => isJidBroadcast(jid) || jid.includes('newsletter'),
        
        getMessage: async (key) => {
            // Fallback para evitar erros de decriptação em mensagens antigas (Retry)
            // Em produção real, você buscaria a mensagem no banco 'messages' se disponível
            return { conversation: 'hello' }; 
        }
    });

    // Armazena referência em memória para acesso rápido pelos Controllers
    sessions.set(sessionId, { sock, companyId });

    // 3. Inicializa os Ouvintes de Eventos (O Cérebro)
    // Passamos o sock para configurar os eventos (mensagens, presença, etc)
    setupListeners({ sock, sessionId, companyId });

    // 4. Gestão de Eventos de Conexão (Ciclo de Vida)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // A) QR CODE GERADO
        if (qr) {
            console.log(`📡 [QR CODE] Novo QR gerado para ${sessionId}`);
            // Atualiza tabela para o Frontend exibir o QR
            await updateInstanceStatus(sessionId, companyId, { 
                status: 'qrcode', 
                qrcode_url: qr,
                sync_status: 'waiting', // Estado inicial
                sync_percent: 0
            });
        }

        // B) CONEXÃO ESTABELECIDA
        if (connection === 'open') {
            console.log(`✅ [CONECTADO] Sessão ${sessionId} online!`);
            
            // Define status como 'connected' mas sync_status como 'importing'
            // Isso dispara a barra de progresso GlobalSyncIndicator no Frontend
            await updateInstanceStatus(sessionId, companyId, { 
                status: 'connected', 
                qrcode_url: null, // Limpa QR
                sync_status: 'importing_contacts', 
                sync_percent: 5,
                profile_pic_url: sock.user?.imgUrl || null
            });
        }

        // C) DESCONEXÃO / QUEDA
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 403;
            
            console.log(`❌ [DESCONECTADO] ${sessionId}. Code: ${statusCode}. Reconectar? ${shouldReconnect}`);

            if (shouldReconnect) {
                // Estratégia de Backoff Simples: Tenta reconectar em 3s
                // Apenas removemos o timer se existir para evitar duplicação
                setTimeout(() => startSession(sessionId, companyId), 3000);
            } else {
                // Logout Definitivo (Ex: Desconectado pelo celular ou Banido)
                console.log(`🧹 [LOGOUT] Limpando dados da sessão ${sessionId}`);
                await deleteSession(sessionId, companyId);
            }
        }
    });

    // Salva credenciais sempre que atualizarem (rotação de chaves de criptografia)
    sock.ev.on('creds.update', saveCreds);

    return sock;
};

// Função para encerrar sessão
export const deleteSession = async (sessionId, companyId) => {
    const session = sessions.get(sessionId);
    if (session) {
        try {
            session.sock.ev.removeAllListeners("connection.update"); // Evita loops
            session.sock.end(undefined); // Fecha socket graciosamente
        } catch(e) {
            console.error("Erro ao fechar socket:", e);
        }
        sessions.delete(sessionId);
    }
    // Remove do banco e limpa auth
    await deleteSessionData(sessionId, companyId);
};
