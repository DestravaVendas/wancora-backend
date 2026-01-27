
const requestCounts = new Map();

// Limpa o mapa a cada 1 minuto para evitar vazamento de memória
setInterval(() => {
    requestCounts.clear();
}, 60000);

export const apiLimiter = (req, res, next) => {
    // Chave única: IP + User ID (se logado)
    const key = `${req.ip}:${req.user?.id || 'anon'}`;
    
    const current = requestCounts.get(key) || 0;
    
    // Limite: 100 requisições por minuto por usuário (Generoso para uso normal, estrito para loops)
    if (current > 100) {
        return res.status(429).json({ 
            error: "Muitas requisições. Acalme-se, cowboy! 🤠",
            retryAfter: 60
        });
    }
    
    requestCounts.set(key, current + 1);
    next();
};
