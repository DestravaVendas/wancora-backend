
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

// Objeto de Log Centralizado
const LoggerInstance = {
    /**
     * Grava um log no banco de dados.
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
            
            // Gravação Fire-and-Forget
            supabase.from('system_logs').insert({
                level,
                source,
                message: (message || '').substring(0, 1000),
                metadata: safeMetadata,
                company_id: companyId,
                created_at: new Date()
            }).then(({ error }) => {
                if (error) {
                    console.error("FATAL LOGGER FAIL: Falha ao escrever log no Supabase:", error.message);
                }
            });
        } catch (e) {
            console.error("FATAL LOGGER FAIL: Exceção crítica no Logger:", e);
        }
    },

    info: (source, message, meta, companyId) => LoggerInstance.log('info', source, message, meta, companyId),
    warn: (source, message, meta, companyId) => LoggerInstance.log('warn', source, message, meta, companyId),
    error: (source, message, meta, companyId) => LoggerInstance.log('error', source, message, meta, companyId),
    fatal: (source, message, meta, companyId) => LoggerInstance.log('fatal', source, message, meta, companyId),

    /**
     * Intercepta console.error e console.warn para gravar no Supabase.
     */
    initConsoleHijack: () => {
        const originalConsoleError = console.error;
        const originalConsoleWarn = console.warn;

        // Symbol único por processo — imune a colisões de string e a falsas triagens
        // globalThis garante escopo único mesmo com múltiplos módulos ESM no mesmo runtime
        const LOGGING_LOCK = Symbol.for('wancora.logger.isLogging');

        console.error = (...args) => {
            // Mutex de recursão: se já estamos dentro do Logger, não entrar de novo
            if (globalThis[LOGGING_LOCK]) return originalConsoleError.apply(console, args);

            originalConsoleError.apply(console, args);
            const msg = args.map(a => (typeof a === 'object' ? (a.message || JSON.stringify(a)) : String(a))).join(' ');

            // Blocklist secundária: erros que NÃO devem gerar log no Supabase
            // (para evitar loop caso o próprio Supabase gere um console.error)
            if (
                msg.includes('rate limit') ||
                msg.includes('socket disconnect') ||
                msg.includes('Falha ao escrever log') ||
                msg.includes('system_logs') ||
                msg.includes('violates check constraint')
            ) return;

            globalThis[LOGGING_LOCK] = true;
            LoggerInstance.error('backend', 'Captured Console Error', { raw: msg, args })
                .finally(() => { globalThis[LOGGING_LOCK] = false; });
        };

        console.warn = (...args) => {
            // Mutex de recursão para warn
            if (globalThis[LOGGING_LOCK]) return originalConsoleWarn.apply(console, args);

            originalConsoleWarn.apply(console, args);
            const msg = args.map(a => String(a)).join(' ');

            if (
                msg.includes('ExperimentalWarning') ||
                msg.includes('Falha ao escrever log')
            ) return;

            globalThis[LOGGING_LOCK] = true;
            LoggerInstance.warn('backend', 'Captured Console Warn', { raw: msg })
                .finally(() => { globalThis[LOGGING_LOCK] = false; });
        };
    }
};

export const Logger = LoggerInstance;
