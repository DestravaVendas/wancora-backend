
import { createClient } from "@supabase/supabase-js";

// Cliente Service Role para garantir escrita irrestrita nos logs
// Usa as variáveis de ambiente carregadas no server.js
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Sanitização robusta contra referências circulares (JSON.stringify falha com elas)
const safeSanitize = (obj, seen = new WeakSet()) => {
    if (!obj || typeof obj !== 'object') return obj;
    
    if (seen.has(obj)) return '[Circular Reference]';
    seen.add(obj);

    if (Array.isArray(obj)) {
        return obj.map(item => safeSanitize(item, seen));
    }

    const cleanObj = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const value = obj[key];
            
            // Trunca strings gigantes para economizar banco e rede
            if (typeof value === 'string' && value.length > 5000) {
                cleanObj[key] = value.substring(0, 5000) + '...[TRUNCATED]';
            } else {
                cleanObj[key] = safeSanitize(value, seen);
            }
        }
    }
    return cleanObj;
};

export const Logger = {
    /**
     * Grava um log no banco de dados.
     * @param {'info'|'warn'|'error'|'fatal'} level - Nível de severidade
     * @param {string} source - Origem (backend, worker, baileys)
     * @param {string} message - Mensagem descritiva
     * @param {object} metadata - Dados técnicos adicionais (stack, payload, ids)
     * @param {string} [companyId] - ID da empresa (opcional)
     */
    log: async (level, source, message, metadata = {}, companyId = null) => {
        // Em dev, mostra no console para debug rápido
        if (process.env.NODE_ENV !== 'production' || level === 'fatal') {
            const timestamp = new Date().toISOString();
            const consoleMsg = `[${timestamp}] [${level.toUpperCase()}] [${source}] ${message}`;
            if (level === 'error' || level === 'fatal') console.error(consoleMsg);
            else console.log(consoleMsg);
        }

        try {
            // Prepara payload seguro
            const safeMetadata = safeSanitize(metadata);
            
            // Gravação Fire-and-Forget (Sem await para não travar a request principal)
            supabase.from('system_logs').insert({
                level,
                source,
                message: (message || '').substring(0, 1000), // Limite de tamanho na mensagem principal
                metadata: safeMetadata,
                company_id: companyId,
                created_at: new Date()
            }).then(({ error }) => {
                if (error) {
                    // Fallback final: se o banco falhar, joga no console original
                    console.error("FATAL LOGGER FAIL: Falha ao escrever log no Supabase:", error.message);
                }
            });
        } catch (e) {
            console.error("FATAL LOGGER FAIL: Exceção crítica no Logger:", e);
        }
    },

    info: (source, message, meta, companyId) => Logger.log('info', source, message, meta, companyId),
    warn: (source, message, meta, companyId) => Logger.log('warn', source, message, meta, companyId),
    error: (source, message, meta, companyId) => Logger.log('error', source, message, meta, companyId),
    fatal: (source, message, meta, companyId) => Logger.log('fatal', source, message, meta, companyId),
};
