
import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ level: 'info' });
let redisClient;

const getRedisClient = () => {
    if (!redisClient) {
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        
        // Oculta senha nos logs para segurança
        const safeUrl = redisUrl.replace(/:[^:]*@/, ':***@');
        logger.info(`🔌 [REDIS] Conectando a: ${safeUrl}`);
        
        redisClient = new Redis(redisUrl, {
            maxRetriesPerRequest: null, // Obrigatório para BullMQ
            enableReadyCheck: false,
            retryStrategy(times) {
                // Backoff exponencial limitado a 2s
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            reconnectOnError: (err) => {
                const targetError = "READONLY";
                if (err.message.includes(targetError)) {
                    // Tenta reconectar se cair em modo somente leitura (comum em failovers)
                    return true;
                }
            }
        });

        redisClient.on('error', (err) => {
            console.error('❌ [REDIS] Erro de conexão:', err.message);
        });

        redisClient.on('connect', () => {
            console.log('✅ [REDIS] Conexão estabelecida com sucesso!');
        });
    }
    return redisClient;
};

export default getRedisClient;
