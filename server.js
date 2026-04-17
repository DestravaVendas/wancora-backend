
import './instrument.js'; // Sentry deve ser o primeiro import
import 'dotenv/config'; 
import { Logger } from './utils/logger.js'; // MOVIDO PARA O TOPO
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('./package.json'); // Versão dinâmica — nunca mais hardcode
import express from 'express';
import cors from 'cors';
import compression from 'compression'; 
import helmet from 'helmet'; 
import * as Sentry from "@sentry/node";
import axios from 'axios'; 
import { createClient } from "@supabase/supabase-js";
import { startSession, shutdownAllSessions } from './services/baileys/connection.js';
import { startSentinel } from './services/scheduler/sentinel.js';
import { startAgendaWorker } from './workers/agendaWorker.js';
import { startRetentionWorker } from './workers/retentionWorker.js';
import { errorHandler } from './middleware/errorHandler.js'; // NOVO: Middleware
import rateLimit from 'express-rate-limit'; // [SECURITY PATCH] Rate Limiter

// --- CONSOLE HIJACKING (Interceptador Global de Logs) ---
Logger.initConsoleHijack();
// --------------------------------------------------------

// Rotas Modulares
import sessionRoutes from './routes/session.routes.js';
import messageRoutes from './routes/message.routes.js';
import automationRoutes from './routes/automation.routes.js';
import managementRoutes from './routes/management.routes.js';
import cloudRoutes from './routes/cloud.routes.js'; 

// --- GESTÃO DE ERROS FATAIS (CRASH PREVENTION) ---
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    Logger.fatal('backend', 'Uncaught Exception detectada!', { 
        error: err.message, 
        stack: err.stack 
    });
    // Dá 1s para o log ser gravado antes de crashar
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    Logger.error('backend', 'Unhandled Rejection detectada!', { 
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : null
    });
});

// --- GRACEFUL SHUTDOWN (Zero-Conflict Deploy) ---
const handleShutdown = async (signal) => {
    console.log(`\n🛑 [${signal}] Recebido. Iniciando encerramento limpo...`);
    
    // 1. Fecha conexões do Baileys (Evita erro 440 Stream Conflict no próximo boot)
    await shutdownAllSessions();
    
    // 2. Aguarda um pouco para limpeza de buffers
    setTimeout(() => {
        console.log('👋 Wancora Backend encerrado. Até logo!');
        process.exit(0);
    }, 1500);
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));


// PATCH: USER-AGENT SPOOFING
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
axios.defaults.headers.common['User-Agent'] = userAgent;

axios.interceptors.request.use(config => {
    config.headers['User-Agent'] = userAgent;
    return config;
});

// WORKERS DE CAMPANHA
if (process.env.REDIS_URL) {
    import('./workers/campaignWorker.js').catch(err => 
        Logger.error('worker', 'Falha ao carregar Campaign Worker', { error: err.message })
    );
}

const app = express();
app.set('trust proxy', 1); // [FIX] Ensina o Express a confiar no Load Balancer Cloud do Render
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// --- MIDDLEWARES & SEGURANÇA ---
app.use(helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false
}));

app.use(cors());
app.use(compression()); 
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- RATE LIMIT GLOBAL (SECURITY PATCH) ---
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 200, // Limita a 200 requisições por minuto por IP (Proteção Anti-DDoS)
    message: { error: 'Too Many Requests - Rate Limit Exceeded' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api', apiLimiter);

// Montagem das Rotas
app.use('/api/v1/session', sessionRoutes);
app.use('/api/v1/message', messageRoutes);
app.use('/api/v1', automationRoutes); 
app.use('/api/v1/management', managementRoutes);
app.use('/api/v1/cloud', cloudRoutes);

// Sentry Error Handler (Antes do nosso handler customizado)
Sentry.setupExpressErrorHandler(app);

// [FIX] Rota de Health Check da API (Monitoramento do Frontend / SystemHealth)
app.get('/api/v1/health', (req, res) => {
    res.status(200).json({ 
        status: 'online', 
        timestamp: new Date().toISOString(),
        service: 'Wancora API',
        version: pkg.version // Lido dinamicamente do package.json
    });
});

// Handler Global de Erros (NOVO)
app.use(errorHandler);

// Health Check de Infraestrutura (Render/AWS) - Mantido na raiz
app.get('/', (req, res) => {
  res.status(200).send({ status: 'online', uptime: process.uptime(), service: 'Wancora Backend' });
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'online', timestamp: new Date().toISOString() });
});

/**
 * 🔄 AUTO-RECONNECT
 */
const restoreSessions = async () => {
    // 🛡️ [FIX MÁXIMO] Aguarda 60s para garantir que o Render destrói o servidor antigo. 
    // Isto IMPEDE o erro 440 Conflict e o Bad MAC!
    console.log("⏳ [BOOT] Aguardando 60s para estabilização de containers pós-deploy...");
    await new Promise(r => setTimeout(r, 60000));

    Logger.info('backend', 'Booting system: Restoring sessions...');
    try {
        const { data: instances, error } = await supabase
            .from('instances')
            .select('session_id, company_id')
            .in('status', ['connected', 'connecting']);

        if (error) throw error;

        if (instances && instances.length > 0) {
            for (const [index, instance] of instances.entries()) {
                setTimeout(() => {
                    startSession(instance.session_id, instance.company_id)
                        .then(() => Logger.info('baileys', `Sessão restaurada: ${instance.session_id}`, {}, instance.company_id))
                        .catch(err => Logger.error('baileys', `Falha ao restaurar sessão: ${instance.session_id}`, { error: err.message }, instance.company_id));
                }, index * 2500); 
            }
        }
    } catch (e) {
        Logger.fatal('backend', 'Erro crítico ao restaurar sessões no boot', { error: e.message });
    }
};

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Wancora Backend v${pkg.version} rodando na porta ${PORT}`);
    
    // Pequeno delay para garantir que o health check do Render passe antes do boot pesado
    setTimeout(() => {
        restoreSessions();     
        startSentinel();       
        startAgendaWorker();   
        startRetentionWorker(); 
    }, 2000);
});

export default app;
