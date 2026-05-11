import { Queue, Worker } from 'bullmq';
import getRedisClient from '../redisClient.js';
import { Logger } from '../../utils/logger.js';
import { internalProcessAI } from './sentinel.js';

const redisConnection = getRedisClient();

export const aiQueue = redisConnection ? new Queue('ai_processing_queue', { connection: redisConnection }) : null;

// Mapa local para debouncing
const messageBuffers = new Map();

/**
 * Entreda principal para o motor de IA.
 * Acumula mensagens de um mesmo remetente (Debounce) e só envia para a Fila Redis
 * após 6 segundos de silêncio, consolidando o texto.
 */
export const enqueueAIAfterDebounce = (messageData) => {
    if (!aiQueue) {
        // Fallback para execução direta se não houver Redis
        console.warn("⚠️ [SENTINEL] Fallback: Sem Redis. Processando IA na RAM.");
        processDebounceInMemory(messageData);
        return;
    }

    const { remote_jid, company_id } = messageData;
    const cacheKey = `${company_id}:${remote_jid}`;

    if (!messageBuffers.has(cacheKey)) {
        messageBuffers.set(cacheKey, {
            messages: [messageData],
            timer: null
        });
    } else {
        const buffer = messageBuffers.get(cacheKey);
        buffer.messages.push(messageData);
        if (buffer.timer) clearTimeout(buffer.timer);
    }

    const buffer = messageBuffers.get(cacheKey);

    buffer.timer = setTimeout(async () => {
        const finalMessages = [...buffer.messages];
        messageBuffers.delete(cacheKey);

        const combinedContent = finalMessages
            .map(m => m.content || m.transcription || "")
            .filter(t => t.length > 0)
            .join("\n");

        if (!combinedContent) return;

        const lastMsg = finalMessages[finalMessages.length - 1];
        const consolidatedData = { ...lastMsg, content: combinedContent };

        try {
            await aiQueue.add('process_ai', consolidatedData, {
                attempts: 2,
                backoff: { type: 'exponential', delay: 10000 },
                removeOnComplete: true,
                removeOnFail: false,
                jobId: `${remote_jid}-${Date.now()}` // Dá rastreabilidade ao Job
            });
            console.log(`📥 [AI QUEUE] Job de IA enfileirado para ${remote_jid}`);
        } catch (e) {
            Logger.error('sentinel', `Falha ao enfileirar job de IA: ${e.message}`, {}, consolidatedData.company_id);
        }
    }, 6000); // 6s de Debounce
};

/**
 * =========================================================================
 * WORKER BULLMQ
 * Processa as requisições de IA tirando-as do Redis assincronamente.
 * =========================================================================
 */
let aiWorker = null;

const serverRole = process.env.SERVER_ROLE || 'monolith';
const shouldRunWorker = serverRole === 'monolith' || serverRole === 'worker';

if (redisConnection && shouldRunWorker) {
    aiWorker = new Worker('ai_processing_queue', async (job) => {
        const messageData = job.data;
        console.log(`⚙️ [AI WORKER] Processando Job ${job.id} para ${messageData.remote_jid}`);
        
        // internalProcessAI (a antiga _internalProcessAI) agora faz o trabalho pesado
        // sem precisar gerenciar a trava local (o BullMQ com concurrency ajustada faz o controle de fluxo).
        await internalProcessAI(messageData);
        
    }, { 
        connection: redisConnection,
        concurrency: 5, // Processa no máximo 5 leads simultâneos por nó para poupar API Key do Gemini
        limiter: {
            max: 20, // max 20 jobs
            duration: 1000 // por segundo
        }
    });

    aiWorker.on('completed', (job) => {
        console.log(`✅ [AI WORKER] Job ${job.id} concluído com sucesso.`);
    });

    aiWorker.on('failed', (job, err) => {
        console.error(`❌ [AI WORKER] Job ${job.id} falhou:`, err.message);
    });
}

// Fallback caso REDIS não esteja online
const processDebounceInMemory = (messageData) => {
    const { remote_jid, company_id } = messageData;
    const cacheKey = `${company_id}:${remote_jid}`;

    if (!messageBuffers.has(cacheKey)) {
        messageBuffers.set(cacheKey, { messages: [messageData], timer: null });
    } else {
        const buffer = messageBuffers.get(cacheKey);
        buffer.messages.push(messageData);
        if (buffer.timer) clearTimeout(buffer.timer);
    }
    const buffer = messageBuffers.get(cacheKey);
    buffer.timer = setTimeout(async () => {
        const finalMessages = [...buffer.messages];
        messageBuffers.delete(cacheKey);
        const combinedContent = finalMessages.map(m => m.content || m.transcription || "").filter(t => t.length > 0).join("\n");
        if (!combinedContent) return;
        const lastMsg = finalMessages[finalMessages.length - 1];
        const consolidatedData = { ...lastMsg, content: combinedContent };
        
        try {
            await internalProcessAI(consolidatedData);
        } catch (e) {
             console.error(`❌ [SENTINEL (RAM)] Erro na fila de ${remote_jid}:`, e.message);
        }
    }, 6000);
};
