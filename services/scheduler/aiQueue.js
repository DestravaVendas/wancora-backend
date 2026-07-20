import { Queue, Worker } from 'bullmq';
import getRedisClient from '../redisClient.js';
import { Logger } from '../../utils/logger.js';
import { internalProcessAI } from './sentinel.js';

const redisConnection = getRedisClient();

export const aiQueue = redisConnection ? new Queue('ai_processing_queue', { connection: redisConnection }) : null;

// Mapa local para debouncing RAM (Fallback)
const messageBuffers = new Map();

/**
 * Entrada principal para o motor de IA.
 * Acumula mensagens de um mesmo remetente (Debounce) e só envia para a Fila Redis
 * após 6 segundos de silêncio, consolidando o texto de forma stateless.
 */
export const enqueueAIAfterDebounce = async (messageData) => {
    if (!aiQueue || !redisConnection) {
        console.warn("⚠️ [SENTINEL] Fallback: Sem Redis. Processando IA na RAM.");
        processDebounceInMemory(messageData);
        return;
    }

    const { remote_jid, company_id } = messageData;
    const listKey = `ai_buffer_list:${company_id}:${remote_jid}`;
    const timeKey = `ai_buffer_time:${company_id}:${remote_jid}`;
    const now = Date.now();

    try {
        // Enfileira mensagem e atualiza o timestamp da última mensagem no Redis
        await redisConnection.rpush(listKey, JSON.stringify(messageData));
        await redisConnection.set(timeKey, now.toString());

        // Agenda a verificação de debounce daqui a 6 segundos no BullMQ
        await aiQueue.add('check_debounce', { 
            listKey, 
            timeKey, 
            remote_jid, 
            company_id, 
            timestamp: now 
        }, {
            delay: 6000,
            removeOnComplete: true,
            removeOnFail: true,
            jobId: `debounce:${remote_jid}-${now}`
        });

        console.log(`📥 [AI DEBOUNCE] Mensagem adicionada ao buffer Redis para ${remote_jid}`);
    } catch (e) {
        Logger.error('sentinel', `Falha ao gerenciar debounce no Redis: ${e.message}`, {}, company_id);
        // Fallback local na RAM
        processDebounceInMemory(messageData);
    }
};

/**
 * =========================================================================
 * WORKER BULLMQ
 * Processa as requisições de IA tirando-as do Redis assincronamente.
 * Diferencia entre verificação de debounce e execução do process_ai.
 * =========================================================================
 */
let aiWorker = null;

const serverRole = process.env.SERVER_ROLE || 'monolith';
const shouldRunWorker = serverRole === 'monolith' || serverRole === 'worker';

if (redisConnection && shouldRunWorker) {
    aiWorker = new Worker('ai_processing_queue', async (job) => {
        // --- CASO A: Verificação de Silêncio do Debounce ---
        if (job.name === 'check_debounce') {
            const { listKey, timeKey, remote_jid, company_id, timestamp } = job.data;
            
            try {
                const lastTimeStr = await redisConnection.get(timeKey);
                if (!lastTimeStr) return;

                const lastTime = parseInt(lastTimeStr, 10);
                if (timestamp < lastTime) {
                    // Outra mensagem chegou depois e estendeu o debounce. Este job caducou.
                    return;
                }

                // --- ANTI-ATROPELAMENTO (TYPING DEBOUNCE) ---
                const typingKey = `ai_typing:${company_id}:${remote_jid}`;
                const isTyping = await redisConnection.get(typingKey);
                
                if (isTyping) {
                    // O humano ainda está digitando. Adiamos a decisão por mais 5s.
                    console.log(`⏳ [AI DEBOUNCE] Humano digitando (${remote_jid}). Reagendando envio...`);
                    const newNow = Date.now();
                    await redisConnection.set(timeKey, newNow.toString());
                    await aiQueue.add('check_debounce', { 
                        listKey, 
                        timeKey, 
                        remote_jid, 
                        company_id, 
                        timestamp: newNow 
                    }, {
                        delay: 5000,
                        removeOnComplete: true,
                        removeOnFail: true,
                        jobId: `debounce:${remote_jid}-${newNow}`
                    });
                    return;
                }

                // O tempo de silêncio de 6s foi respeitado e o humano parou de digitar. Consolidamos as mensagens.
                const rawMsgs = await redisConnection.lrange(listKey, 0, -1);
                await redisConnection.del(listKey, timeKey);

                if (!rawMsgs || rawMsgs.length === 0) return;

                const finalMessages = rawMsgs.map(m => JSON.parse(m));
                const combinedContent = finalMessages
                    .map(m => m.content || m.transcription || "")
                    .filter(t => t.length > 0)
                    .join("\n");

                if (!combinedContent) return;

                const lastMsg = finalMessages[finalMessages.length - 1];
                const consolidatedData = { ...lastMsg, content: combinedContent };

                // Adiciona o job definitivo para a IA responder
                await aiQueue.add('process_ai', consolidatedData, {
                    attempts: 2,
                    backoff: { type: 'exponential', delay: 10000 },
                    removeOnComplete: true,
                    removeOnFail: false,
                    jobId: `ai:${remote_jid}-${Date.now()}`
                });
                console.log(`📥 [AI DEBOUNCE] Debounce finalizado para ${remote_jid}. Job process_ai enfileirado.`);

            } catch (err) {
                console.error(`❌ [AI WORKER] Erro no check_debounce para ${remote_jid}:`, err.message);
            }
            return;
        }

        // --- CASO B: Processamento do Sentinel ---
        const messageData = job.data;
        console.log(`⚙️ [AI WORKER] Processando Job ${job.id} para ${messageData.remote_jid}`);
        await internalProcessAI(messageData);
        
    }, { 
        connection: redisConnection,
        concurrency: 5, // Processa no máximo 5 leads simultâneos por nó para poupar a chave
        limiter: {
            max: 20, // max 20 jobs
            duration: 1000 // por segundo
        }
    });

    aiWorker.on('completed', (job) => {
        if (job.name === 'process_ai') {
            console.log(`✅ [AI WORKER] Job ${job.id} concluído com sucesso.`);
        }
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
    
    const checkAndExecute = async () => {
        // --- ANTI-ATROPELAMENTO RAM ---
        const typingKey = `ai_typing:${company_id}:${remote_jid}`;
        const typingExpireAt = global.aiTypingMap?.get(typingKey);
        
        if (typingExpireAt && Date.now() < typingExpireAt) {
            console.log(`⏳ [AI DEBOUNCE RAM] Humano digitando (${remote_jid}). Adiando 5s...`);
            buffer.timer = setTimeout(checkAndExecute, 5000);
            return;
        }

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
    };

    buffer.timer = setTimeout(checkAndExecute, 6000);
};
