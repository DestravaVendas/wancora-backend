
import express from "express";
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { createCampaign } from "../controllers/campaignController.js"; 
import { sendAppointmentConfirmation } from '../controllers/appointmentController.js';
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// --- RATE LIMITER: Proteção da rota pública de agendamentos ---
// 10 requisições por IP a cada 15 minutos (900 segundos)
// Usa RateLimiterMemory (sem Redis) — suficiente para proteção básica em instância única
const appointmentLimiter = new RateLimiterMemory({
    points: 10,         // Número de requisições permitidas
    duration: 900,      // Janela de tempo em segundos (15 min)
    blockDuration: 900, // Bloqueia por mais 15 min após esgotar os pontos
});

const appointmentRateLimit = async (req, res, next) => {
    try {
        await appointmentLimiter.consume(req.ip);
        next();
    } catch {
        res.status(429).json({
            error: 'Muitas requisições. Tente novamente em 15 minutos.',
            retryAfter: 900
        });
    }
};

// --- VALIDAÇÃO DE SECRET INTERNO ---
// Garante que apenas o Next.js (ou sistema autorizado) pode chamar esta rota.
// Configure INTERNAL_API_SECRET no .env com um valor forte (ex: openssl rand -hex 32)
const requireInternalSecret = (req, res, next) => {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) {
        // Se a variável não está configurada, bloqueia como medida de segurança fail-safe
        console.error('🚨 [SECURITY] INTERNAL_API_SECRET não configurado. Bloqueando rota pública.');
        return res.status(503).json({ error: 'Serviço não configurado corretamente.' });
    }
    const providedSecret = req.headers['x-internal-secret'];
    if (!providedSecret || providedSecret !== secret) {
        console.warn(`🚨 [SECURITY] Tentativa não autorizada em /appointments/confirm — IP: ${req.ip}`);
        return res.status(403).json({ error: 'Acesso não autorizado.' });
    }
    next();
};

// --- ROTAS PÚBLICAS / SERVER-TO-SERVER ---
// Protegida por: Rate Limit (anti-DDoS) + Secret Header (anti-acesso externo não autorizado)
router.post('/appointments/confirm',
    appointmentRateLimit,
    requireInternalSecret,
    sendAppointmentConfirmation
);

// --- ROTAS PROTEGIDAS (DASHBOARD) ---
router.use(requireAuth);

// Campanhas em Massa
router.post("/campaigns/send", createCampaign);

export default router;
