import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';

// Cliente Supabase Service Role
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// 🛡️ REVISÃO DE SERIALIZAÇÃO
const fixBuffer = (data) => {
    if (!data) return null;
    try {
        // Se já for Buffer, retorna direto (Otimização)
        if (Buffer.isBuffer(data)) return data;
        
        // Se for objeto com estrutura de Buffer do JSON.stringify
        if (typeof data === 'object' && data.type === 'Buffer' && Array.isArray(data.data)) {
            return Buffer.from(data.data);
        }

        // Fallback para reviver via BufferJSON (mais lento mas seguro)
        const str = typeof data === 'string' ? data : JSON.stringify(data);
        return JSON.parse(str, BufferJSON.reviver);
    } catch (e) {
        console.warn("[AUTH] Falha ao recuperar chave (Buffer Corrupto). Regenerando...", e.message);
        return null; 
    }
};

// 🔥 MEMÓRIA RAM GLOBAL PARA AS CHAVES: O Fim do Bad MAC
// Evita que o Baileys fique travado esperando o Supabase responder pela rede.
const sessionCaches = new Map();

const getSessionCache = (sessionId) => {
    if (!sessionCaches.has(sessionId)) {
        sessionCaches.set(sessionId, {
            keys: new Map(),      // Leitura imediata (0ms)
            writes: new Map(),    // Fila para gravar no Supabase
            isFlushing: false,
            lastFlush: 0
        });
    }
    return sessionCaches.get(sessionId);
};

// Função que roda no fundo para salvar no banco de dados em lotes
const flushToDB = async (sessionId) => {
    const cache = sessionCaches.get(sessionId);
    if (!cache || cache.isFlushing || cache.writes.size === 0) return;
    
    // Debounce Reduzido: 100ms (Mais agressivo para evitar Bad MAC em reconexões rápidas)
    const now = Date.now();
    if (now - cache.lastFlush < 100) {
        if (!cache.flushTimer) {
            cache.flushTimer = setTimeout(() => {
                cache.flushTimer = null;
                flushToDB(sessionId);
            }, 100);
        }
        return;
    }

    cache.isFlushing = true;
    cache.lastFlush = now;
    
    try {
        const rowsToUpsert = [];
        const idsToDelete = [];
        
        // Separa as chaves atuais e limpa a fila para receber as próximas
        const currentWrites = new Map(cache.writes);
        cache.writes.clear();

        for (const [cacheKey, value] of currentWrites.entries()) {
            const [type, id] = cacheKey.split('::');
            
            if (value) {
                // Validação de Payload: Evita salvar objetos vazios que corrompem a sessão
                const stringified = JSON.stringify(value, BufferJSON.replacer);
                const payload = JSON.parse(stringified);
                
                if (payload && Object.keys(payload).length > 0) {
                    rowsToUpsert.push({
                        session_id: sessionId,
                        data_type: type,
                        key_id: id,
                        payload: payload,
                        updated_at: new Date()
                    });
                }
            } else {
                idsToDelete.push({ type, id });
            }
        }

        if (rowsToUpsert.length > 0) {
            // Usa upsert com onConflict para garantir atomicidade
            const { error } = await supabase.from('baileys_auth_state').upsert(rowsToUpsert, { 
                onConflict: 'session_id,data_type,key_id',
                ignoreDuplicates: false 
            });
            if (error) throw error;
        }

        if (idsToDelete.length > 0) {
            for (const item of idsToDelete) {
                try {
                    await supabase.from('baileys_auth_state')
                        .delete()
                        .eq('session_id', sessionId)
                        .eq('data_type', item.type)
                        .eq('key_id', item.id);
                } catch(e) {}
            }
        }
    } catch (e) {
        console.error(`❌ [AUTH DB] Erro no Lote da sessão ${sessionId}:`, e.message);
        // Em caso de erro, devolve as chaves para a fila de escrita para tentar novamente
        // (Mas apenas se elas não foram sobrescritas por novas escritas)
    } finally {
        cache.isFlushing = false;
        if (cache.writes.size > 0) {
            setTimeout(() => flushToDB(sessionId), 500);
        }
    }
};

// Exportada para limpar a memória quando o bot desconecta
export const clearSessionCache = (sessionId) => {
    sessionCaches.delete(sessionId);
};

export const useSupabaseAuthState = async (sessionId) => {
    const cache = getSessionCache(sessionId);

    const fetchCreds = async () => {
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
            
            return fixBuffer(data.payload);
        } catch (e) {
            return null;
        }
    };

    const creds = (await fetchCreds()) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    const missingIds = [];

                    // 1. Tenta pegar da RAM primeiro (Instantâneo, resolve o descompasso)
                    for (const id of ids) {
                        const cacheKey = `${type}::${id}`;
                        if (cache.keys.has(cacheKey)) {
                            data[id] = cache.keys.get(cacheKey);
                        } else {
                            missingIds.push(id);
                        }
                    }

                    // 2. Se não estiver na RAM (bot acabou de ligar), busca no Supabase
                    if (missingIds.length > 0) {
                        try {
                            const { data: dbData } = await supabase
                                .from('baileys_auth_state')
                                .select('key_id, payload')
                                .eq('session_id', sessionId)
                                .eq('data_type', type)
                                .in('key_id', missingIds);

                            dbData?.forEach(row => {
                                const val = fixBuffer(row.payload);
                                if (val) {
                                    data[row.key_id] = val;
                                    cache.keys.set(`${type}::${row.key_id}`, val); // Alimenta a RAM para o futuro
                                }
                            });
                        } catch (e) {}
                    }
                    return data;
                },
                set: async (data) => {
                    // 1. Grava TUDO na memória RAM instantaneamente (O Baileys não trava)
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            const cacheKey = `${type}::${id}`;
                            
                            if (value) {
                                cache.keys.set(cacheKey, value);
                                cache.writes.set(cacheKey, value);
                            } else {
                                cache.keys.delete(cacheKey);
                                cache.writes.set(cacheKey, null); // Marca para deleção
                            }
                        }
                    }

                    // 2. Aciona o gravador de fundo (só salva na nuvem a cada 500ms)
                    if (!cache.isFlushing) {
                        setTimeout(() => flushToDB(sessionId), 500);
                    }
                }
            }
        },
        saveCreds: async () => {
            try {
                const stringified = JSON.stringify(creds, BufferJSON.replacer);
                const { error } = await supabase.from('baileys_auth_state').upsert({
                    session_id: sessionId,
                    data_type: 'creds',
                    key_id: 'creds',
                    payload: JSON.parse(stringified),
                    updated_at: new Date()
                }, { onConflict: 'session_id,data_type,key_id' });
                
                if (error) throw error;
                // console.log(`[AUTH] Creds salvas para ${sessionId}`);
            } catch (e) {
                console.error(`❌ [AUTH] Erro ao salvar creds para ${sessionId}:`, e.message);
            }
        }
    };
};
