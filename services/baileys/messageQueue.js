
import { handleMessage } from './handlers/messageHandler.js';

// =============================================================================
// CONFIGURAÇÃO DA FILA — ISOLAMENTO POR SESSÃO
//
// Em vez de uma fila global compartilhada (que causa starvation entre empresas),
// cada sessão possui seu próprio estado de fila e pool de workers.
//
// Arquitetura:
//   sessionQueues: Map<sessionId, { queue: Array, activeWorkers: number }>
//
// Benefícios:
//   - Empresa A processando áudio pesado NÃO bloqueia Empresa B
//   - Workers por sessão evitam monopolização do pool global
//   - Mensagens realtime (isRealtime=true) têm inserção prioritária (head insert)
//
// Manual §10 & §12: Processamento não-bloqueante e isolado é requisito de estabilidade.
// =============================================================================

const CONCURRENCY_PER_SESSION = 3; // Workers simultâneos por sessão (ajustar conforme CPU/I/O)
const TASK_TIMEOUT_MS = 90_000;     // 90s — timeout máximo por tarefa (download de mídia pesada)

// Map: sessionId -> { queue: [], activeWorkers: number }
const sessionQueues = new Map();

/**
 * Garante que o estado da fila para a sessão exista.
 * @param {string} sessionId
 * @returns {{ queue: Array, activeWorkers: number }}
 */
const getSessionState = (sessionId) => {
    if (!sessionQueues.has(sessionId)) {
        sessionQueues.set(sessionId, { queue: [], activeWorkers: 0 });
    }
    return sessionQueues.get(sessionId);
};

/**
 * Wrapper de timeout para qualquer Promise.
 * Garante que um worker não fique preso indefinidamente em I/O travado.
 * @param {Promise} promise - A promise a ser executada
 * @param {number} ms - Timeout em milissegundos
 * @param {string} label - Label para log de diagnóstico
 * @returns {Promise}
 */
const withTimeout = (promise, ms, label = 'task') => {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`⏰ Timeout (${ms}ms) excedido: ${label}`)), ms)
    );
    return Promise.race([promise, timeout]);
};

/**
 * Processador interno da fila de uma sessão.
 * Pega tarefas e executa respeitando CONCURRENCY_PER_SESSION.
 * Ao finalizar uma tarefa, automaticamente tenta consumir a próxima da mesma sessão.
 * @param {string} sessionId
 */
const processNext = async (sessionId) => {
    const state = getSessionState(sessionId);

    // Para se atingiu o limite de concorrência para esta sessão ou fila vazia
    if (state.activeWorkers >= CONCURRENCY_PER_SESSION || state.queue.length === 0) return;

    state.activeWorkers++;
    const task = state.queue.shift();

    try {
        // Executa com timeout de segurança — impede que mídia/IA trave o slot para sempre
        await withTimeout(
            handleMessage(task.msg, task.sock, task.companyId, task.sessionId, task.isRealtime),
            TASK_TIMEOUT_MS,
            `msg:${task.msg.key?.id}`
        );
    } catch (error) {
        // 🛡️ ERRO BLINDADO: Captura qualquer falha (incluindo timeout) sem travar a fila
        console.error(
            `❌ [QUEUE:${sessionId}] Falha na msg ${task.msg.key?.id}:`,
            error.message
        );
    } finally {
        // SEMPRE decrementa — garante que o slot é liberado mesmo em caso de erro ou timeout
        state.activeWorkers--;

        // Limpa o Map se a sessão ficou completamente ociosa (evita leak de memória)
        if (state.activeWorkers === 0 && state.queue.length === 0) {
            sessionQueues.delete(sessionId);
        }

        // Gatilho: ao liberar slot, tenta consumir a próxima tarefa da mesma sessão
        processNext(sessionId);
    }
};

/**
 * Adiciona uma mensagem à fila de processamento da sessão correspondente.
 *
 * 🚀 ORDENAÇÃO CRONOLÓGICA (ETAPA 3):
 * Como o Wancora agora opera com Zero Bottleneck (lixo histórico foi amputado),
 * todas as mensagens são enfileiradas via .push() para garantir que a IA (Sentinel)
 * e o CRM leiam a conversa na ordem exata em que o lead digitou.
 * 
 * O antigo 'unshift' foi removido pois invertia a ordem de mensagens em rajadas rápidas.
 *
 * @param {object} msg - Objeto mensagem do Baileys
 * @param {object} sock - Socket da conexão
 * @param {string} companyId - ID da empresa
 * @param {string} sessionId - ID da sessão (chave de isolamento)
 * @param {boolean} isRealtime - Se é mensagem nova (true) ou histórico (false)
 */
export const enqueueMessage = (msg, sock, companyId, sessionId, isRealtime) => {
    const state = getSessionState(sessionId);
    const task = { msg, sock, companyId, sessionId, isRealtime };

    // Fila estrita e cronológica
    state.queue.push(task);

    // Tenta iniciar processamento (non-blocking — não aguarda a Promise aqui)
    processNext(sessionId);
};

/**
 * Retorna métricas agregadas de todas as filas ativas para monitoramento.
 * @returns {{ sessions: number, totalPending: number, totalActive: number, detail: object }}
 */
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

/**
 * Drena (limpa) a fila de uma sessão — útil ao desconectar/destruir uma instância.
 * @param {string} sessionId
 */
export const drainSessionQueue = (sessionId) => {
    sessionQueues.delete(sessionId);
};
