import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ level: 'info' });
let redisClient;

const getRedisClient = () => {
    if (!redisClient) {
        const redisUrl = process.env.REDIS_URL;
        
        if (!redisUrl) {
            console.warn("⚠️ [REDIS] Variável REDIS_URL não definida. Funcionalidades de fila (Campanha) ficarão indisponíveis.");
            return null;
        }
        
        // Oculta senha nos logs para segurança
        const safeUrl = redisUrl.replace(/:[^:]*@/, ':***@');
        logger.info(`🔌 [REDIS] Conectando a: ${safeUrl}`);
        
        redisClient = new Redis(redisUrl, {
            maxRetriesPerRequest: null, // Obrigatório para BullMQ
            enableReadyCheck: false,
            // Retry Strategy mais agressiva para evitar crash no boot
            retryStrategy(times) {
                const delay = Math.min(times * 100, 3000);
                return delay;
            },
            reconnectOnError: (err) => {
                const targetError = "READONLY";
                if (err.message.includes(targetError)) {
                    return true;
                }
            }
        });

        redisClient.on('error', (err) => {
            // Evita crash do processo por erro não tratado no Redis
            console.error('❌ [REDIS] Erro de conexão (Background):', err.message);
        });

        redisClient.on('connect', () => {
            console.log('✅ [REDIS] Conexão estabelecida com sucesso!');
        });
    }
    return redisClient;
};

export default getRedisClient;