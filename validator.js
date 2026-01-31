
import { z } from 'zod';

export const validate = (schema) => (req, res, next) => {
    try {
        // Valida tanto body quanto query e params, priorizando body para POST
        const dataToValidate = { ...req.query, ...req.params, ...req.body };
        
        // Zod parse (lança erro se inválido)
        schema.parse(dataToValidate);
        
        next();
    } catch (error) {
        if (error instanceof z.ZodError) {
            // Formata o erro do Zod para ser legível no Frontend
            const errors = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
            return res.status(400).json({ error: "Dados inválidos", details: errors });
        }
        next(error);
    }
};
