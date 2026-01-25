
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

// Conexão Redis dedicada para o Produtor da Fila
// BullMQ recomenda conexões separadas para filas e workers
const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null
});

export const campaignQueue = new Queue('campaign-sender', { connection });

connection.on('connect', () => console.log('✅ [REDIS] Conectado para fila de campanhas.'));
connection.on('error', (err) => console.error('❌ [REDIS] Erro na conexão da fila:', err));
