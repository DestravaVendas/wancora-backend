import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// Criamos o cliente aqui para evitar dependência circular com sync.js
// e garantir que o Auth funcione independente do resto do sistema.
export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// 🛡️ CORREÇÃO CRÍTICA (FIX BUFFER)
// Transforma objetos { type: 'Buffer', data: [...] } de volta em Buffers reais.
// Isso impede que o Baileys rejeite a sessão ao reiniciar.
const fixBuffer = (data) => {
    return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
};

export const useSupabaseAuthState = async (sessionId) => {
    
    // 1. Carrega credenciais iniciais
    const fetchCreds = async () => {
        try {
            const { data } = await supabase
                .from('baileys_auth_state')
                .select('payload')
                .eq('session_id', sessionId)
                .eq('data_type', 'creds')
                .eq('key_id', 'creds')
                .maybeSingle();
            
            // APLICA O FIXBUFFER AQUI
            return data?.payload ? fixBuffer(JSON.parse(data.payload)) : null;
        } catch (e) {
            console.error('[AUTH] Erro ao buscar credenciais:', e);
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
                            // APLICA O FIXBUFFER AQUI TAMBÉM
                            result[row.key_id] = fixBuffer(JSON.parse(row.payload));
                        });
                        return result;
                    } catch (e) {
                        console.error(`[AUTH] Erro ao ler chaves ${type}:`, e);
                        return {};
                    }
                },
                set: async (data) => {
                    const rows = [];
                    const idsToDelete = [];

                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            
                            if (value) {
                                // Se tem valor, prepara para salvar (Upsert)
                                rows.push({
                                    session_id: sessionId,
                                    data_type: type,
                                    key_id: id,
                                    // BufferJSON.replacer garante que salva corretamente
                                    payload: JSON.stringify(value, BufferJSON.replacer),
                                    updated_at: new Date()
                                });
                            } else {
                                // Se é null/undefined, marca para deletar
                                idsToDelete.push({ type, id });
                            }
                        }
                    }

                    // 1. EXECUTA O UPSERT EM LOTE (Muito mais rápido e gera QR Code na hora)
                    if (rows.length > 0) {
                        try {
                            const { error } = await supabase
                                .from('baileys_auth_state')
                                .upsert(rows, { onConflict: 'session_id, data_type, key_id' });
                            
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
                            } catch (e) {}
                        }
                    }
                }
            }
        },
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
