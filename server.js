
import 'dotenv/config'; 
import express from 'express';
import cors from 'cors';
import routes from './routes.js';
import { createClient } from "@supabase/supabase-js";
import { startSession } from './services/baileys/connection.js';
import { startSentinel } from './services/scheduler/sentinel.js';
import { startAgendaWorker } from './workers/agendaWorker.js';

// 🔥 INICIALIZAÇÃO DOS WORKERS DE CAMPANHA 🔥
// Importa apenas se o REDIS estiver configurado para evitar crash em dev
if (process.env.REDIS_URL) {
    import('./workers/campaignWorker.js').catch(err => console.error("Falha ao carregar Campaign Worker:", err));
}

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Configurações de Segurança e Parser
app.use(cors());
// Limite de 50mb é essencial para envio de vídeos/áudios grandes via API
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rotas da API
app.use('/api/v1', routes);

// Rota de Health Check para o Render/Pingdom não matarem o serviço
app.get('/', (req, res) => {
  res.status(200).send({ status: 'online', uptime: process.uptime(), service: 'Wancora Backend' });
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'online', timestamp: new Date().toISOString() });
});

// Tratamento de Erros Global
app.use((err, req, res, next) => {
    console.error('❌ [SERVER ERROR]', err);
    res.status(500).json({ error: 'Erro interno do servidor.', details: err.message });
});

/**
 * 🔄 AUTO-RECONNECT (RESURRECTION STRATEGY)
 * Ao iniciar, busca todas as instâncias que deveriam estar conectadas e as reinicia.
 * Isso garante que, se o servidor reiniciar (deploy), os clientes não precisem ler o QR Code novamente.
 */
const restoreSessions = async () => {
    console.log('🔄 [BOOT] Verificando sessões para restaurar...');
    try {
        // Busca sessões que estavam marcadas como conectadas ou conectando
        const { data: instances, error } = await supabase
            .from('instances')
            .select('session_id, company_id')
            .in('status', ['connected', 'connecting']);

        if (error) throw error;

        if (instances && instances.length > 0) {
            console.log(`🔄 [BOOT] Restaurando ${instances.length} sessões...`);
            
            // Inicia em paralelo, mas com um pequeno delay entre cada uma para não saturar CPU/Memória
            // Staggered Start: 2.5s de intervalo
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
    console.log(`🚀 Wancora Backend v5.0 rodando na porta ${PORT}`);
    console.log(`🔗 Endpoint: http://localhost:${PORT}/api/v1`);
    
    // Inicia serviços auxiliares
    restoreSessions();     // Reconecta WhatsApps
    startSentinel();       // Inicia IA Agente
    startAgendaWorker();   // Inicia Cron de Lembretes
});

export default app;
