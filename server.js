
import './instrument.js'; // Sentry deve ser o primeiro import
import 'dotenv/config'; 
import express from 'express';
import cors from 'cors';
import compression from 'compression'; 
import helmet from 'helmet'; // Novo Import de Segurança
import * as Sentry from "@sentry/node";
import axios from 'axios'; 
import { createClient } from "@supabase/supabase-js";
import { startSession } from './services/baileys/connection.js';
import { startSentinel } from './services/scheduler/sentinel.js';
import { startAgendaWorker } from './workers/agendaWorker.js';
import { startRetentionWorker } from './workers/retentionWorker.js'; // NOVO

// Rotas Modulares
import sessionRoutes from './routes/session.routes.js';
import messageRoutes from './routes/message.routes.js';
import automationRoutes from './routes/automation.routes.js';
import managementRoutes from './routes/management.routes.js';
import cloudRoutes from './routes/cloud.routes.js'; 

// --- GESTÃO DE ERROS FATAIS (CRASH PREVENTION) ---
// Impede que o servidor caia se uma sessão específica falhar na criptografia
process.on('uncaughtException', (err) => {
    console.error('🔥 [UNCAUGHT EXCEPTION] Erro crítico capturado:', err);
    // Não encerra o processo para manter o serviço ativo para outros tenants
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 [UNHANDLED REJECTION] Promise rejeitada:', reason);
});

// 🔥 PATCH CRÍTICO: USER-AGENT SPOOFING (INTERCEPTOR) 🔥
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
axios.defaults.headers.common['User-Agent'] = userAgent;

axios.interceptors.request.use(config => {
    config.headers['User-Agent'] = userAgent;
    return config;
});

// 🔥 INICIALIZAÇÃO DOS WORKERS DE CAMPANHA 🔥
if (process.env.REDIS_URL) {
    import('./workers/campaignWorker.js').catch(err => console.error("Falha ao carregar Campaign Worker:", err));
}

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// --- MIDDLEWARES & SEGURANÇA ---

// Helmet: Proteção de Headers HTTP
app.use(helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false // Desativa CSP estrito para APIs
}));

app.use(cors());
app.use(compression()); // Gzip Compression
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Montagem das Rotas (Modularizada)
app.use('/api/v1/session', sessionRoutes);
app.use('/api/v1/message', messageRoutes);
app.use('/api/v1', automationRoutes); 
app.use('/api/v1/management', managementRoutes);
app.use('/api/v1/cloud', cloudRoutes);

// Sentry Error Handler (Deve vir depois das rotas)
Sentry.setupExpressErrorHandler(app);

// Health Check
app.get('/', (req, res) => {
  res.status(200).send({ status: 'online', uptime: process.uptime(), service: 'Wancora Backend' });
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'online', timestamp: new Date().toISOString() });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('❌ [SERVER ERROR]', err);
    res.status(500).json({ error: 'Erro interno do servidor.', details: err.message });
});

/**
 * 🔄 AUTO-RECONNECT
 */
const restoreSessions = async () => {
    console.log('🔄 [BOOT] Verificando sessões para restaurar...');
    try {
        const { data: instances, error } = await supabase
            .from('instances')
            .select('session_id, company_id')
            .in('status', ['connected', 'connecting']);

        if (error) throw error;

        if (instances && instances.length > 0) {
            console.log(`🔄 [BOOT] Restaurando ${instances.length} sessões...`);
            
            for (const [index, instance] of instances.entries()) {
                setTimeout(() => {
                    startSession(instance.session_id, instance.company_id)
                        .then(() => console.log(`✅ [BOOT] Sessão ${instance.session_id} restaurada.`))
                        .catch(err => console.error(`❌ [BOOT] Falha ao restaurar ${instance.session_id}:`, err.message));
                }, index * 2500); 
            }
        } else {
            console.log('ℹ️ [BOOT] Nenhuma sessão ativa encontrada para restaurar.');
        }
    } catch (e) {
        console.error('❌ [BOOT] Erro crítico ao restaurar sessões:', e);
    }
};

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`🚀 Wancora Backend v5.4.1 (Stability Patch) rodando na porta ${PORT}`);
    console.log(`🔗 Endpoint: http://localhost:${PORT}/api/v1`);
    
    restoreSessions();     
    startSentinel();       
    startAgendaWorker();   
    startRetentionWorker(); // Inicia limpeza automática
});

export default app;
