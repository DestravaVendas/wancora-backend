import IORedis from 'ioredis';
import pino from 'pino';

const logger = pino({ level: 'info' });

let client;

function getRedisClient() {
    if (!client) {
        if (!process.env.REDIS_URL) {
            logger.error('FATAL: REDIS_URL não definida.');
            process.exit(1); 
        }

        client = new IORedis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null, // Obrigatório para BullMQ
            enableReadyCheck: false
        });

        client.on('error', (err) => logger.error({ err }, 'Erro Redis'));
        client.on('connect', () => logger.info('✅ Redis Conectado (Singleton)'));
    }
    return client;
}

export default getRedisClient;