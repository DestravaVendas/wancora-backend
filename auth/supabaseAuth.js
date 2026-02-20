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
        if (Buffer.isBuffer(data)) return data;
        if (typeof data === 'string') {
            return JSON.parse(data, BufferJSON.reviver);
        }
        if (typeof data === 'object') {
            if (data.type === 'Buffer' && Array.isArray(data.data)) {
                return Buffer.from(data.data);
            }
            const str = JSON.stringify(data);
            return JSON.parse(str, BufferJSON.reviver);
        }
        return data;
    } catch (e) {
        console.warn("[AUTH] Falha ao recuperar chave (Buffer Corrupto). Regenerando...", e.message);
        return null; 
    }
};

// --- SISTEMA DE LOCK ASSÍNCRONO (IMPEDE CORRUPÇÃO DE ESCRITA SIMULTÂNEA) ---
// Isto resolve o "Bad MAC" causado pelo Event-Driven (Corrida de Catraca)
const writeLocks = new Map();

class Mutex {
    constructor() {
        this.queue = [];
        this.locked = false;
    }
    async lock() {
        return new Promise(resolve => {
            if (this.locked) {
                this.queue.push(resolve);
            } else {
                this.locked = true;
                resolve();
            }
        });
    }
    unlock() {
        if (this.queue.length > 0) {
            const nextResolve = this.queue.shift();
            nextResolve();
        } else {
            this.locked = false;
        }
    }
}

const getLock = (sessionId) => {
    if (!writeLocks.has(sessionId)) {
        writeLocks.set(sessionId, new Mutex());
    }
    return writeLocks.get(sessionId);
};

export const useSupabaseAuthState = async (sessionId) => {
    
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
                    const mutex = getLock(sessionId);
                    await mutex.lock(); // Inicia o Lock Exclusivo

                    try {
                        const rowsToUpsert = [];
                        const idsToDelete = [];

                        for (const type in data) {
                            for (const id in data[type]) {
                                const value = data[type][id];
                                
                                if (value) {
                                    const stringified = JSON.stringify(value, BufferJSON.replacer);
                                    
                                    rowsToUpsert.push({
                                        session_id: sessionId,
                                        data_type: type,
                                        key_id: id,
                                        payload: JSON.parse(stringified), 
                                        updated_at: new Date()
                                    });
                                } else {
                                    idsToDelete.push({ type, id });
                                }
                            }
                        }

                        if (rowsToUpsert.length > 0) {
                            const { error } = await supabase
                                .from('baileys_auth_state')
                                .upsert(rowsToUpsert, { onConflict: 'session_id, data_type, key_id' });
                            
                            if (error) console.error('[AUTH DB] Erro Upsert:', error.message);
                        }

                        if (idsToDelete.length > 0) {
                            for (const item of idsToDelete) {
                                await supabase
                                    .from('baileys_auth_state')
                                    .delete()
                                    .eq('session_id', sessionId)
                                    .eq('data_type', item.type)
                                    .eq('key_id', item.id)
                                    .catch(() => {});
                            }
                        }
                    } catch (e) {
                        console.error('[AUTH NET] Erro:', e.message);
                    } finally {
                        mutex.unlock(); // Liberta o Lock para a próxima operação
                    }
                }
            }
        },
        saveCreds: async () => {
            const mutex = getLock(sessionId);
            await mutex.lock();

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
            } finally {
                mutex.unlock();
            }
        }
    };
};
