
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { supabase } from '../crm/sync.js';

/**
 * Custom Auth Adapter para Supabase
 * Substitui o useMultiFileAuthState por banco de dados.
 */
export const useSupabaseAuthState = async (sessionId) => {
    // 1. Carrega credenciais iniciais (creds.json virtual)
    const fetchCreds = async () => {
        const { data } = await supabase
            .from('baileys_auth_state')
            .select('payload')
            .eq('session_id', sessionId)
            .eq('data_type', 'creds')
            .eq('key_id', 'creds')
            .maybeSingle();
        
        return data?.payload ? JSON.parse(data.payload, BufferJSON.reviver) : null;
    };

    const creds = (await fetchCreds()) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const { data } = await supabase
                        .from('baileys_auth_state')
                        .select('key_id, payload')
                        .eq('session_id', sessionId)
                        .eq('data_type', type)
                        .in('key_id', ids);

                    const result = {};
                    data?.forEach(row => {
                        result[row.key_id] = JSON.parse(row.payload, BufferJSON.reviver);
                    });
                    return result;
                },
                set: async (data) => {
                    const rows = [];
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            if (value) {
                                rows.push({
                                    session_id: sessionId,
                                    data_type: type,
                                    key_id: id,
                                    payload: JSON.stringify(value, BufferJSON.replacer),
                                    updated_at: new Date()
                                });
                            } else {
                                // Delete logic if value is null (optional for clean up)
                                await supabase
                                    .from('baileys_auth_state')
                                    .delete()
                                    .eq('session_id', sessionId)
                                    .eq('data_type', type)
                                    .eq('key_id', id);
                            }
                        }
                    }
                    if (rows.length > 0) {
                        await supabase.from('baileys_auth_state').upsert(rows, { onConflict: 'session_id,data_type,key_id' });
                    }
                }
            }
        },
        saveCreds: async () => {
            await supabase.from('baileys_auth_state').upsert({
                session_id: sessionId,
                data_type: 'creds',
                key_id: 'creds',
                payload: JSON.stringify(creds, BufferJSON.replacer),
                updated_at: new Date()
            }, { onConflict: 'session_id,data_type,key_id' });
        }
    };
};
