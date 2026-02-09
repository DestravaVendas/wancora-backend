
import './instrument.js'; // Sentry deve ser o primeiro import
import 'dotenv/config'; 
import express from 'express';
import cors from 'cors';
import compression from 'compression'; 
import helmet from 'helmet'; 
import * as Sentry from "@sentry/node";
import axios from 'axios'; 
import { createClient } from "@supabase/supabase-js";
import { startSession } from './services/baileys/connection.js';
import { startSentinel } from './services/scheduler/sentinel.js';
import { startAgendaWorker } from './workers/agendaWorker.js';
import { startRetentionWorker } from './workers/retentionWorker.js';
import { Logger } from './utils/logger.js'; // NOVO: Logger
import { errorHandler } from './middleware/errorHandler.js'; // NOVO: Middleware

// --- CONSOLE HIJACKING (Interceptador Global de Logs) ---
// Isso captura logs de bibliotecas (Baileys, Express) e try/catchs silenciosos
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

console.error = (...args) => {
    // 1. Mantém o comportamento original (Terminal)
    originalConsoleError.apply(console, args);
    
    // 2. Envia para o Supabase (Evita loop infinito se o erro for do próprio logger)
    const msg = args.map(a => (typeof a === 'object' ? (a.message || JSON.stringify(a)) : String(a))).join(' ');
    
    // Filtra ruídos comuns que não são erros reais
    if (msg.includes('rate limit') || msg.includes('socket disconnect')) return;

    Logger.error('backend-console', 'Captured Console Error', { raw: msg, args });
};

console.warn = (...args) => {
    originalConsoleWarn.apply(console, args);
    const msg = args.map(a => String(a)).join(' ');
    // Filtra avisos irrelevantes do Node
    if (msg.includes('ExperimentalWarning')) return;
    
    Logger.warn('backend-console', 'Captured Console Warn', { raw: msg });
};
// --------------------------------------------------------

// Rotas Modulares
import sessionRoutes from './routes/session.routes.js';
import messageRoutes from './routes/message.routes.js';
import automationRoutes from './routes/automation.routes.js';
import managementRoutes from './routes/management.routes.js';
import cloudRoutes from './routes/cloud.routes.js'; 

// --- GESTÃO DE ERROS FATAIS (CRASH PREVENTION) ---
process.on('uncaughtException', (err) => {
    Logger.fatal('backend', 'Uncaught Exception (Process Crash prevented)', {
        message: err.message,
        stack: err.stack
    });
    // Não encerra o processo para manter o serviço ativo para outros tenants, mas loga como FATAL
});

process.on('unhandledRejection', (reason, promise) => {
    Logger.error('backend', 'Unhandled Rejection', {
        reason: reason instanceof Error ? reason.message : reason,
        stack: reason instanceof Error ? reason.stack : null
    });
});

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

// Montagem das Rotas
app.use('/api/v1/session', sessionRoutes);
app.use('/api/v1/message', messageRoutes);
app.use('/api/v1', automationRoutes); 
app.use('/api/v1/management', managementRoutes);
app.use('/api/v1/cloud', cloudRoutes);

// Sentry Error Handler (Antes do nosso handler customizado)
Sentry.setupExpressErrorHandler(app);

// Handler Global de Erros (NOVO)
app.use(errorHandler);

// Health Check
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

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`🚀 Wancora Backend v5.4.1 (Stability Patch) rodando na porta ${PORT}`);
    
    restoreSessions();     
    startSentinel();       
    startAgendaWorker();   
    startRetentionWorker(); 
});

export default app;
