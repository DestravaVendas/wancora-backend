
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';

// Cliente Supabase Service Role (Acesso total para ler/gravar sessões)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// 🛡️ CORREÇÃO CRÍTICA (FIX BUFFER & JSON PARSING)
// Garante que qualquer dado lido do banco seja convertido corretamente para Buffer
const fixBuffer = (data) => {
    if (!data) return null;
    try {
        // Se já é objeto, tenta reviver
        if (typeof data === 'object') {
            // Verifica se é um Buffer disfarçado de objeto (formato do Baileys antigo)
            if (data.type === 'Buffer' && Array.isArray(data.data)) {
                return Buffer.from(data.data);
            }
            // Se já for Buffer real, retorna
            if (Buffer.isBuffer(data)) return data;
            
            // Tenta passar pelo reviver do Baileys convertendo pra string e voltando
            const str = JSON.stringify(data);
            return JSON.parse(str, BufferJSON.reviver);
        }
        
        // Se for string, parseia com reviver
        if (typeof data === 'string') {
            return JSON.parse(data, BufferJSON.reviver);
        }
        
        return data;
    } catch (e) {
        // Se falhar a conversão, o dado está corrompido. Retornar null força o Baileys a regenerar a chave.
        // Isso é melhor que travar o processo.
        console.warn("[AUTH] Buffer corrompido detectado, regenerando chave...");
        return null;
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
            console.error(`[AUTH] Falha ao ler credenciais de ${sessionId}:`, e.message);
            return null;
        }
    };

    const creds = (await fetchCreds()) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                // Leitura de chaves (Pre-keys, Sessions, SenderKeys, etc.)
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
                            const val = fixBuffer(row.payload);
                            if (val) {
                                result[row.key_id] = val;
                            }
                        });
                        return result;
                    } catch (e) {
                        console.error(`[AUTH] Erro crítico ao ler chaves ${type}:`, e);
                        return {};
                    }
                },
                // Escrita de chaves (Atomic Upsert com Delay para evitar Rate Limit do Banco)
                set: async (data) => {
                    const rowsToUpsert = [];
                    const idsToDelete = [];

                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            
                            if (value) {
                                // Se tem valor, prepara para salvar
                                // Serializa usando BufferJSON.replacer para garantir integridade do Buffer
                                const stringified = JSON.stringify(value, BufferJSON.replacer);
                                
                                rowsToUpsert.push({
                                    session_id: sessionId,
                                    data_type: type,
                                    key_id: id,
                                    payload: JSON.parse(stringified), // Salva como JSONB nativo no Postgres
                                    updated_at: new Date()
                                });
                            } else {
                                idsToDelete.push({ type, id });
                            }
                        }
                    }

                    // 1. EXECUTA O UPSERT EM LOTE
                    if (rowsToUpsert.length > 0) {
                        try {
                            const { error } = await supabase
                                .from('baileys_auth_state')
                                .upsert(rowsToUpsert, { onConflict: 'session_id, data_type, key_id' });
                            
                            if (error) console.error('[AUTH DB] Erro Upsert:', error.message);
                        } catch (e) {
                            console.error('[AUTH NET] Erro Upsert:', e.message);
                        }
                    }

                    // 2. EXECUTA DELEÇÕES
                    if (idsToDelete.length > 0) {
                        for (const item of idsToDelete) {
                            try {
                                await supabase
                                    .from('baileys_auth_state')
                                    .delete()
                                    .eq('session_id', sessionId)
                                    .eq('data_type', item.type)
                                    .eq('key_id', item.id);
                            } catch (e) { /* ignore */ }
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            try {
                // Serializa corretamente antes de salvar
                const stringified = JSON.stringify(creds, BufferJSON.replacer);
                
                await supabase.from('baileys_auth_state').upsert({
                    session_id: sessionId,
                    data_type: 'creds',
                    key_id: 'creds',
                    payload: JSON.parse(stringified),
                    updated_at: new Date()
                }, { onConflict: 'session_id,data_type,key_id' });
            } catch (e) {
                console.error('[AUTH] Erro ao salvar creds:', e);
            }
        }
    };
};
