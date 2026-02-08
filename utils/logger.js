
import { createClient } from "@supabase/supabase-js";

// Cliente Service Role para garantir escrita irrestrita nos logs
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const sanitizeMeta = (meta) => {
    try {
        return JSON.parse(JSON.stringify(meta)); // Remove referências circulares
    } catch (e) {
        return { error: "Circular structure in metadata" };
    }
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
        // Em dev, ainda mostra no console para facilitar debug local
        if (process.env.NODE_ENV !== 'production' || level === 'fatal') {
            const consoleMsg = `[${level.toUpperCase()}] [${source}] ${message}`;
            if (level === 'error' || level === 'fatal') console.error(consoleMsg, metadata);
            else console.log(consoleMsg);
        }

        try {
            // Gravação Fire-and-Forget (Não await para não bloquear a thread principal)
            supabase.from('system_logs').insert({
                level,
                source,
                message: message.substring(0, 1000), // Trunca mensagens muito longas
                metadata: sanitizeMeta(metadata),
                company_id: companyId,
                created_at: new Date()
            }).then(({ error }) => {
                if (error) console.error("FATAL: Falha ao escrever log no Supabase:", error);
            });
        } catch (e) {
            console.error("FATAL: Exceção no Logger:", e);
        }
    },

    info: (source, message, meta, companyId) => Logger.log('info', source, message, meta, companyId),
    warn: (source, message, meta, companyId) => Logger.log('warn', source, message, meta, companyId),
    error: (source, message, meta, companyId) => Logger.log('error', source, message, meta, companyId),
    fatal: (source, message, meta, companyId) => Logger.log('fatal', source, message, meta, companyId),
};
