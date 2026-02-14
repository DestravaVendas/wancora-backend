
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

export const useSupabaseAuthState = async (sessionId) => {
    
    // 1. Carrega credenciais principais (creds.json)
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
                        const { data } = await supabase
                            .from('baileys_auth_state')
                            .select('key_id, payload')
                            .eq('session_id', sessionId)
                            .eq('data_type', type)
                            .in('key_id', ids);

                        const result = {};
                        data?.forEach(row => {
                            // IMPORTANTE: Aplica o fixBuffer em cada chave recuperada
                            const val = fixBuffer(row.payload);
                            if (val) {
                                result[row.key_id] = val;
                            }
                        });
                        return result;
                    } catch (e) {
                        console.error(`[AUTH] Erro leitura keys ${type}:`, e.message);
                        return {};
                    }
                },
                set: async (data) => {
                    const rowsToUpsert = [];
                    const idsToDelete = [];

                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            
                            if (value) {
                                // Serializa garantindo que Buffers virem { type: 'Buffer', data: [...] }
                                const stringified = JSON.stringify(value, BufferJSON.replacer);
                                
                                rowsToUpsert.push({
                                    session_id: sessionId,
                                    data_type: type,
                                    key_id: id,
                                    payload: JSON.parse(stringified), // Salva como JSON puro no banco
                                    updated_at: new Date()
                                });
                            } else {
                                idsToDelete.push({ type, id });
                            }
                        }
                    }

                    if (rowsToUpsert.length > 0) {
                        try {
                            // Upsert em lote para performance
                            const { error } = await supabase
                                .from('baileys_auth_state')
                                .upsert(rowsToUpsert, { onConflict: 'session_id, data_type, key_id' });
                            
                            if (error) console.error('[AUTH DB] Erro Upsert:', error.message);
                        } catch (e) {
                            console.error('[AUTH NET] Erro:', e.message);
                        }
                    }

                    if (idsToDelete.length > 0) {
                        for (const item of idsToDelete) {
                            try {
                                await supabase
                                    .from('baileys_auth_state')
                                    .delete()
                                    .eq('session_id', sessionId)
                                    .eq('data_type', item.type)
                                    .eq('key_id', item.id);
                            } catch (e) {}
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            try {
                const stringified = JSON.stringify(creds, BufferJSON.replacer);
                await supabase.from('baileys_auth_state').upsert({
                    session_id: sessionId,
                    data_type: 'creds',
                    key_id: 'creds',
                    payload: JSON.parse(stringified),
                    updated_at: new Date()
                }, { onConflict: 'session_id,data_type,key_id' });
            } catch (e) {
                console.error('[AUTH] Erro saveCreds:', e.message);
            }
        }
    };
};
