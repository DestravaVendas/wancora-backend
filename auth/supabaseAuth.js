import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';

// Cliente Supabase Service Role
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// 🛡️ REVISÃO DE SERIALIZAÇÃO
// Transforma dados do banco (JSONB) de volta para Buffer compatível com Baileys
const fixBuffer = (data) => {
    if (!data) return null;
    try {
        // Se já for Buffer, retorna
        if (Buffer.isBuffer(data)) return data;

        // Se for string JSON
        if (typeof data === 'string') {
            return JSON.parse(data, BufferJSON.reviver);
        }

        // Se for Objeto JSONB do Postgres (o caso mais comum de erro)
        if (typeof data === 'object') {
            // Verifica assinatura do BufferJSON { type: 'Buffer', data: [...] }
            if (data.type === 'Buffer' && Array.isArray(data.data)) {
                return Buffer.from(data.data);
            }
            // Tenta reviver recursivamente (caso tenha buffers aninhados)
            const str = JSON.stringify(data);
            return JSON.parse(str, BufferJSON.reviver);
        }
        
        return data;
    } catch (e) {
        console.warn("[AUTH] Falha ao recuperar chave (Buffer Corrupto). Regenerando...", e.message);
        return null; // Retornar null força o Baileys a recriar a chave
    }
};

// --- 🛡️ SISTEMA DE CACHE E DEBOUNCE (SHIELD ANTI-CORRUPÇÃO) ---
// Estas variáveis globais mantêm as chaves na RAM ultra-rápida
const credsCache = new Map(); // RAM Cache por Sessão
const debounceTimeouts = new Map(); // Controle de tempo do Render
const pendingWrites = new Map(); // Fila de espera de gravação

/**
 * Motor de gravação segura. Ele agrupa centenas de chaves num lote só e 
 * aguarda 2 segundos de estabilidade antes de salvar no banco de dados.
 */
const debouncedCommit = (sessionId) => {
    if (debounceTimeouts.has(sessionId)) {
        clearTimeout(debounceTimeouts.get(sessionId));
    }

    const timeout = setTimeout(async () => {
        const writes = pendingWrites.get(sessionId);
        if (!writes) return;

        // Pega as tarefas e limpa o buffer na RAM
        const rowsToUpsert = [...writes.upserts.values()];
        const rowsToDelete = [...writes.deletes.values()];
        
        writes.upserts.clear();
        writes.deletes.clear();

        // Grava Todos os Upserts de uma só vez (Máxima Performance)
        if (rowsToUpsert.length > 0) {
            try {
                await supabase.from('baileys_auth_state').upsert(rowsToUpsert, { onConflict: 'session_id, data_type, key_id' });
            } catch (e) {
                console.error('[AUTH DB] Erro no Batch Upsert:', e.message);
            }
        }

        // Deleta as chaves antigas
        if (rowsToDelete.length > 0) {
            for (const item of rowsToDelete) {
                try {
                    await supabase.from('baileys_auth_state').delete()
                        .eq('session_id', sessionId)
                        .eq('data_type', item.type)
                        .eq('key_id', item.id);
                } catch (e) {}
            }
        }
    }, 2000); // 2 Segundos de espera segura (Evita gravar pela metade se o Render reiniciar)

    debounceTimeouts.set(sessionId, timeout);
};

export const useSupabaseAuthState = async (sessionId) => {
    
    // Inicializa o estado da RAM para esta sessão
    if (!credsCache.has(sessionId)) credsCache.set(sessionId, new Map());
    if (!pendingWrites.has(sessionId)) pendingWrites.set(sessionId, { upserts: new Map(), deletes: new Map() });

    // 1. Carrega credenciais principais (creds.json)
    const fetchCreds = async () => {
        // Tenta da Memória RAM primeiro (Zero Custo e Imediato)
        if (credsCache.get(sessionId).has('creds-creds')) {
            return credsCache.get(sessionId).get('creds-creds');
        }

        try {
            const { data, error } = await supabase
                .from('baileys_auth_state')
                .select('payload')
                .eq('session_id', sessionId)
                .eq('data_type', 'creds')
                .eq('key_id', 'creds')
                .maybeSingle();
            
            if (error) throw error;
            if (!data?.payload) return null;
            
            const parsed = fixBuffer(data.payload);
            if (parsed) credsCache.get(sessionId).set('creds-creds', parsed); // Salva na RAM
            return parsed;
        } catch (e) {
            console.error(`[AUTH] Falha leitura creds ${sessionId}:`, e.message);
            return null;
        }
    };

    const creds = (await fetchCreds()) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    try {
                        const result = {};
                        const missingIds = [];

                        // 1. Tenta buscar da RAM primeiro
                        for (const id of ids) {
                            const cacheKey = `${type}-${id}`;
                            if (credsCache.get(sessionId).has(cacheKey)) {
                                result[id] = credsCache.get(sessionId).get(cacheKey);
                            } else {
                                missingIds.push(id);
                            }
                        }

                        // 2. Só vai ao banco de dados procurar o que a RAM não tem
                        if (missingIds.length > 0) {
                            const { data } = await supabase
                                .from('baileys_auth_state')
                                .select('key_id, payload')
                                .eq('session_id', sessionId)
                                .eq('data_type', type)
                                .in('key_id', missingIds);

                            data?.forEach(row => {
                                const val = fixBuffer(row.payload);
                                if (val) {
                                    result[row.key_id] = val;
                                    // Ensina à RAM para a próxima vez
                                    credsCache.get(sessionId).set(`${type}-${row.key_id}`, val);
                                }
                            });
                        }
                        return result;
                    } catch (e) {
                        console.error(`[AUTH] Erro leitura keys ${type}:`, e.message);
                        return {};
                    }
                },
                set: async (data) => {
                    const writes = pendingWrites.get(sessionId);

                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            const cacheKey = `${type}-${id}`;
                            
                            if (value) {
                                // 1. Aplica na Memória RAM imediatamente para uso do Baileys
                                credsCache.get(sessionId).set(cacheKey, value);
                                
                                // 2. Prepara pacote seguro para o banco
                                const stringified = JSON.stringify(value, BufferJSON.replacer);
                                writes.upserts.set(cacheKey, {
                                    session_id: sessionId,
                                    data_type: type,
                                    key_id: id,
                                    payload: JSON.parse(stringified), // Mantém como JSON puro
                                    updated_at: new Date()
                                });
                                writes.deletes.delete(cacheKey);
                            } else {
                                // Limpa da RAM
                                credsCache.get(sessionId).delete(cacheKey);
                                
                                // Põe na fila de exclusão
                                writes.deletes.set(cacheKey, { type, id });
                                writes.upserts.delete(cacheKey);
                            }
                        }
                    }
                    
                    // Aciona o escudo (aguarda o fim das rajadas antes de ir ao banco)
                    debouncedCommit(sessionId);
                }
            }
        },
        saveCreds: () => {
            const writes = pendingWrites.get(sessionId);
            
            // Atualiza RAM local instantaneamente
            credsCache.get(sessionId).set('creds-creds', creds);
            
            try {
                // Prepara pacote seguro para o banco
                const stringified = JSON.stringify(creds, BufferJSON.replacer);
                writes.upserts.set('creds-creds', {
                    session_id: sessionId,
                    data_type: 'creds',
                    key_id: 'creds',
                    payload: JSON.parse(stringified),
                    updated_at: new Date()
                });
                
                // Aciona o escudo
                debouncedCommit(sessionId);
            } catch (e) {
                console.error('[AUTH] Erro saveCreds:', e.message);
            }
        }
    };
};
