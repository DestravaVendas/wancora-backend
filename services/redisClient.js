
import Redis from 'ioredis';

let redisClient;

const getRedisClient = () => {
    if (!redisClient) {
        const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
        
        console.log(`🔌 Conectando ao Redis: ${redisUrl.replace(/:[^:]*@/, ':***@')}`); // Oculta senha no log
        
        redisClient = new Redis(redisUrl, {
            maxRetriesPerRequest: null, // Obrigatório para BullMQ
            enableReadyCheck: false,
            retryStrategy(times) {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
        });

        redisClient.on('error', (err) => {
            console.error('❌ Erro Redis:', err.message);
        });

        redisClient.on('connect', () => {
            console.log('✅ Redis conectado!');
        });
    }
    return redisClient;
};

export default getRedisClient;
