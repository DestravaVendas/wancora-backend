
import { handleMessage } from './handlers/messageHandler.js';

// Configuração da Fila
const CONCURRENCY_LIMIT = 10; // Processa no máximo 10 mensagens simultaneamente
const queue = [];
let activeWorkers = 0;

/**
 * Processador da Fila (Worker)
 * Pega itens da fila e executa o handleMessage respeitando o limite de concorrência.
 */
const processNext = async () => {
    // Se atingiu o limite ou fila vazia, para. Não agende recursão se não há trabalho.
    if (activeWorkers >= CONCURRENCY_LIMIT || queue.length === 0) return;

    activeWorkers++;
    const task = queue.shift();

    try {
        // Executa a lógica pesada (DB, Media Download, Webhook)
        await handleMessage(
            task.msg, 
            task.sock, 
            task.companyId, 
            task.sessionId, 
            task.isRealtime
        );
    } catch (error) {
        console.error(`❌ [QUEUE] Erro ao processar mensagem ${task.msg.key?.id}:`, error.message);
    } finally {
        activeWorkers--;
        // Gatilho: Ao terminar um, tenta pegar o próximo imediatamente
        processNext();
    }
};

/**
 * Adiciona uma mensagem à fila de processamento.
 * @param {object} msg - Objeto mensagem do Baileys
 * @param {object} sock - Socket da conexão
 * @param {string} companyId - ID da empresa
 * @param {string} sessionId - ID da sessão
 * @param {boolean} isRealtime - Se é mensagem nova ou histórico
 */
export const enqueueMessage = (msg, sock, companyId, sessionId, isRealtime) => {
    queue.push({ msg, sock, companyId, sessionId, isRealtime });
    
    // Tenta iniciar o processamento se houver slots livres
    processNext();
};

/**
 * Retorna métricas da fila para monitoramento
 */
export const getQueueStats = () => ({
    pending: queue.length,
    active: activeWorkers
});
