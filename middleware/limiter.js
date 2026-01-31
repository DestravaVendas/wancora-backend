
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import getRedisClient from '../services/redisClient.js';

// Configurações Base
const MAX_REQUESTS_PER_MINUTE = 200; 
const BASE_BLOCK_DURATION = 60; // 1 minuto inicial

let rateLimiter;
let redisClient;

const initLimiter = () => {
    redisClient = getRedisClient();

    if (redisClient) {
        // MODO PRODUÇÃO: Usa Redis (Persistente e Distribuído)
        console.log('🛡️ [LIMITER] Redis ativado com Punição Exponencial.');
        
        rateLimiter = new RateLimiterRedis({
            storeClient: redisClient,
            keyPrefix: 'middleware_limiter',
            points: MAX_REQUESTS_PER_MINUTE,
            duration: 60, // por 60 segundos
            blockDuration: BASE_BLOCK_DURATION,
            insuranceLimiter: new RateLimiterRedis({
                storeClient: redisClient,
                keyPrefix: 'middleware_limiter_insurance',
                points: 1, // Apenas para controle de penalidade
                duration: 60 * 60 * 24 // 24h
            })
        });
    } else {
        // MODO FALLBACK: Memória
        console.warn('⚠️ [LIMITER] Redis não disponível. Usando Memória (Sem punição progressiva).');
        rateLimiter = new RateLimiterMemory({
            points: MAX_REQUESTS_PER_MINUTE,
            duration: 60,
            blockDuration: BASE_BLOCK_DURATION
        });
    }
};

// Inicializa imediatamente
initLimiter();

/**
 * Calcula a punição baseada no número de infrações (Strikes)
 */
const calculatePenalty = async (key) => {
    if (!redisClient) return BASE_BLOCK_DURATION;

    const strikesKey = `strikes:${key}`;
    
    // Incrementa contador de infrações (Expira em 6 horas se o usuário se comportar)
    const strikes = await redisClient.incr(strikesKey);
    if (strikes === 1) await redisClient.expire(strikesKey, 60 * 60 * 6);

    // ESCALADA DE PENA
    let penalty = BASE_BLOCK_DURATION; // Padrão: 60s
    let message = "Aviso: Limite excedido.";

    if (strikes === 2) {
        penalty = 60 * 10; // 10 minutos
        message = "Reincidência detectada. Bloqueio de 10 minutos.";
    } else if (strikes === 3) {
        penalty = 60 * 60; // 1 hora
        message = "Comportamento abusivo. Bloqueio de 1 hora.";
    } else if (strikes >= 4) {
        penalty = 60 * 60 * 24; // 24 horas (Jail)
        message = "IP Banido por 24 horas por ataques repetidos.";
    }

    // Aplica o bloqueio manualmente no Redis
    await rateLimiter.block(key, penalty);
    
    return { penalty, message, strikes };
};

export const apiLimiter = async (req, res, next) => {
    if (!rateLimiter) {
        initLimiter();
        if (!rateLimiter) return next(); 
    }

    // Chave única: Se logado usa ID, senão usa IP
    const key = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip}`;

    try {
        await rateLimiter.consume(key);
        next();
    } catch (rejRes) {
        // --- BLOQUEIO ACIONADO ---
        
        let retrySecs = Math.round(rejRes.msBeforeNext / 1000) || 60;
        let warningMsg = "Muitas requisições. Acalme-se! 🤠";

        // Se estivermos usando Redis, aplicamos a lógica de punição progressiva
        if (redisClient && !rejRes.isFirstInDuration) {
             // Se já estava bloqueado e tentou de novo, ou se estourou agora
             try {
                const { penalty, message } = await calculatePenalty(key);
                retrySecs = penalty;
                warningMsg = message;
                console.warn(`🛡️ [DDoS BLOCK] Alvo: ${key} | Tempo: ${penalty}s | Motivo: ${message}`);
             } catch (err) {
                 console.error("Erro ao calcular penalidade:", err);
             }
        }

        res.set('Retry-After', String(retrySecs));
        return res.status(429).json({
            error: "Limite de Requisições Excedido (429)",
            message: warningMsg,
            details: `Sua conexão foi temporariamente bloqueada por segurança. Tente novamente em ${retrySecs} segundos.`,
            retryAfter: retrySecs
        });
    }
};
