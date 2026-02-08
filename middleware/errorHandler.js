
import { Logger } from '../utils/logger.js';

export const errorHandler = (err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    const isError = statusCode >= 500;

    // Loga o erro com contexto completo da requisição
    Logger.log(
        isError ? 'error' : 'warn',
        'backend',
        err.message || 'Erro Desconhecido',
        {
            stack: err.stack,
            path: req.path,
            method: req.method,
            body: req.body,
            query: req.query,
            ip: req.ip,
            user_id: req.user?.id
        },
        req.user?.company_id || req.body?.companyId
    );

    // Resposta segura para o cliente (esconde stack trace em produção)
    res.status(statusCode).json({
        error: statusCode === 500 ? 'Erro interno do servidor.' : err.message,
        details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
};
