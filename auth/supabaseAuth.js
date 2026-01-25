
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';

// Cliente Supabase Service Role (Acesso total para ler/gravar sessões)
// É vital usar a Service Key aqui, pois sessões não pertencem a um usuário logado no contexto HTTP do backend
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// 🛡️ CORREÇÃO CRÍTICA (FIX BUFFER)
// O Baileys serializa Buffers como { type: 'Buffer', data: [...] }.
// Ao ler do JSON do banco, precisamos converter de volta para Buffer nativo do Node.js,
// caso contrário a criptografia falha silenciosamente.
const fixBuffer = (data) => {
    return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
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
            
            if (error) {
                console.error(`[AUTH] Erro ao buscar credenciais para ${sessionId}:`, error.message);
                return null;
            }
            
            // Aplica o fixBuffer imediatamente após o parse
            return data?.payload ? fixBuffer(JSON.parse(data.payload)) : null;
        } catch (e) {
            console.error('[AUTH] Exceção crítica ao ler credenciais:', e);
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
                            // Vital: Converter string JSON -> Objeto com Buffers
                            result[row.key_id] = fixBuffer(JSON.parse(row.payload));
                        });
                        return result;
                    } catch (e) {
                        console.error(`[AUTH] Erro ao ler chaves ${type}:`, e);
                        return {};
                    }
                },
                // Escrita de chaves (Atomic Upsert)
                set: async (data) => {
                    const rowsToUpsert = [];
                    const idsToDelete = [];

                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            
                            if (value) {
                                // Se tem valor, prepara para salvar (Upsert)
                                rowsToUpsert.push({
                                    session_id: sessionId,
                                    data_type: type,
                                    key_id: id,
                                    // BufferJSON.replacer garante que Buffers virem arrays seguros para JSON
                                    payload: JSON.stringify(value, BufferJSON.replacer),
                                    updated_at: new Date()
                                });
                            } else {
                                // Se é null/undefined, marca para deletar
                                idsToDelete.push({ type, id });
                            }
                        }
                    }

                    // 1. EXECUTA O UPSERT EM LOTE (Muito mais rápido e gera menos I/O no banco)
                    if (rowsToUpsert.length > 0) {
                        try {
                            const { error } = await supabase
                                .from('baileys_auth_state')
                                .upsert(rowsToUpsert, { onConflict: 'session_id, data_type, key_id' });
                            
                            if (error) console.error('[AUTH DB] Erro ao salvar chaves:', error.message);
                        } catch (e) {
                            console.error('[AUTH NET] Erro de rede ao salvar:', e.message);
                        }
                    }

                    // 2. EXECUTA DELEÇÕES SE NECESSÁRIO
                    if (idsToDelete.length > 0) {
                        for (const item of idsToDelete) {
                            try {
                                await supabase
                                    .from('baileys_auth_state')
                                    .delete()
                                    .eq('session_id', sessionId)
                                    .eq('data_type', item.type)
                                    .eq('key_id', item.id);
                            } catch (e) {
                                console.error('[AUTH] Erro ao deletar chave:', e);
                            }
                        }
                    }
                }
            }
        },
        // Função para salvar especificamente o arquivo 'creds' (que muda com frequência)
        saveCreds: async () => {
            try {
                await supabase.from('baileys_auth_state').upsert({
                    session_id: sessionId,
                    data_type: 'creds',
                    key_id: 'creds',
                    payload: JSON.stringify(creds, BufferJSON.replacer),
                    updated_at: new Date()
                }, { onConflict: 'session_id,data_type,key_id' });
            } catch (e) {
                console.error('[AUTH] Erro ao salvar creds.json:', e);
            }
        }
    };
};
