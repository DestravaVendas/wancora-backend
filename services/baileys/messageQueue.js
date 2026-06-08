import { Queue, Worker } from 'bullmq';
import getRedisClient from '../redisClient.js';
import { handleMessage } from './handlers/messageHandler.js';
import { sessions } from './connection.js';

const redisConnection = getRedisClient();

export const messageQueue = redisConnection 
    ? new Queue('message_processing_queue', { connection: redisConnection }) 
    : null;

// Map local: sessionId -> { queue: [], activeWorkers: number } (Fallback RAM)
const sessionQueues = new Map();
const CONCURRENCY_PER_SESSION = 3;
const TASK_TIMEOUT_MS = 90_000;

const getSessionState = (sessionId) => {
    if (!sessionQueues.has(sessionId)) {
        sessionQueues.set(sessionId, { queue: [], activeWorkers: 0 });
    }
    return sessionQueues.get(sessionId);
};

const withTimeout = (promise, ms, label = 'task') => {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`⏰ Timeout (${ms}ms) excedido: ${label}`)), ms)
    );
    return Promise.race([promise, timeout]);
};

// Fallback RAM Processing
const processNextRAM = async (sessionId) => {
    const state = getSessionState(sessionId);
    if (state.activeWorkers >= CONCURRENCY_PER_SESSION || state.queue.length === 0) return;

    state.activeWorkers++;
    const task = state.queue.shift();

    try {
        await withTimeout(
            handleMessage(task.msg, task.sock, task.companyId, task.sessionId, task.isRealtime),
            TASK_TIMEOUT_MS,
            `msg:${task.msg.key?.id}`
        );
    } catch (error) {
        console.error(`❌ [QUEUE:RAM:${sessionId}] Falha na msg ${task.msg.key?.id}:`, error.message);
    } finally {
        state.activeWorkers--;
        if (state.activeWorkers === 0 && state.queue.length === 0) {
            sessionQueues.delete(sessionId);
        }
        processNextRAM(sessionId);
    }
};

const enqueueRAM = (msg, sock, companyId, sessionId, isRealtime) => {
    const state = getSessionState(sessionId);
    state.queue.push({ msg, sock, companyId, sessionId, isRealtime });
    processNextRAM(sessionId);
};

/**
 * Adiciona uma mensagem à fila de processamento da sessão correspondente.
 */
export const enqueueMessage = async (msg, sock, companyId, sessionId, isRealtime) => {
    if (!messageQueue) {
        // Fallback local na RAM
        enqueueRAM(msg, sock, companyId, sessionId, isRealtime);
        return;
    }

    const payload = {
        msg,
        companyId,
        sessionId,
        isRealtime
    };

    try {
        await messageQueue.add('process_message', payload, {
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
            jobId: `msg:${sessionId}:${msg.key?.id}` // Idempotência baseada em ID de mensagem
        });
    } catch (e) {
        console.error(`❌ [MESSAGE QUEUE] Falha ao enfileirar no Redis (fallback para RAM):`, e.message);
        enqueueRAM(msg, sock, companyId, sessionId, isRealtime);
    }
};

/**
 * Worker BullMQ
 */
let messageWorker = null;
const serverRole = process.env.SERVER_ROLE || 'monolith';
const shouldRunWorker = serverRole === 'monolith' || serverRole === 'worker';

if (redisConnection && shouldRunWorker) {
    messageWorker = new Worker('message_processing_queue', async (job) => {
        const { msg, companyId, sessionId, isRealtime } = job.data;
        
        const session = sessions.get(sessionId);
        if (!session || !session.sock) {
            // Se a sessão está offline, lança erro para re-tentar depois quando o socket reestabelecer
            throw new Error(`Sessão ${sessionId} offline. Aguardando socket reestabelecer.`);
        }

        await withTimeout(
            handleMessage(msg, session.sock, companyId, sessionId, isRealtime),
            TASK_TIMEOUT_MS,
            `msg:${msg.key?.id}`
        );
        
    }, {
        connection: redisConnection,
        concurrency: 10 // Processamento simultâneo geral de mensagens
    });

    messageWorker.on('completed', (job) => {
        console.log(`✅ [MESSAGE WORKER] Mensagem ${job.data.msg?.key?.id} processada com sucesso.`);
    });

    messageWorker.on('failed', (job, err) => {
        console.error(`❌ [MESSAGE WORKER] Mensagem ${job?.data?.msg?.key?.id} falhou:`, err.message);
    });
}

export const getQueueStats = () => {
    let totalPending = 0;
    let totalActive = 0;
    const detail = {};

    for (const [sessionId, state] of sessionQueues.entries()) {
        totalPending += state.queue.length;
        totalActive += state.activeWorkers;
        detail[sessionId] = { pending: state.queue.length, active: state.activeWorkers };
    }

    return { sessions: sessionQueues.size, totalPending, totalActive, detail };
};

export const drainSessionQueue = (sessionId) => {
    sessionQueues.delete(sessionId);
};
