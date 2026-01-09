import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: {
    persistSession: false // Otimização para backend
  }
});

export const useSupabaseAuthState = async (sessionId) => {
  // Função auxiliar para escrever dados no banco (com retry simples)
  const writeData = async (data, type, id) => {
    try {
        const payload = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        
        // Tentativa de salvar
        const { error } = await supabase.from("baileys_auth_state").upsert({
          session_id: sessionId,
          data_type: type,
          key_id: id,
          payload: payload,
          updated_at: new Date()
        }, { onConflict: 'session_id, data_type, key_id' });

        if (error) {
            // Se falhar, tentamos uma segunda vez após 500ms (ajuda em oscilações)
            await new Promise(r => setTimeout(r, 500));
            const { error: retryError } = await supabase.from("baileys_auth_state").upsert({
                session_id: sessionId,
                data_type: type,
                key_id: id,
                payload: payload,
                updated_at: new Date()
            }, { onConflict: 'session_id, data_type, key_id' });
            
            if (retryError) console.error(`[AUTH ERROR] Falha final ao salvar ${type}/${id}:`, retryError.message);
        }
    } catch (e) {
        console.error(`[AUTH CRITICAL] Erro de rede ao salvar ${type}:`, e.message);
    }
  };

  const readData = async (type, id) => {
    try {
        const { data, error } = await supabase
          .from("baileys_auth_state")
          .select("payload")
          .eq("session_id", sessionId)
          .eq("data_type", type)
          .eq("key_id", id)
          .single();

        if (error || !data) return null;
        return JSON.parse(JSON.stringify(data.payload), BufferJSON.reviver);
    } catch (e) {
        return null;
    }
  };

  const removeData = async (type, id) => {
    try {
        await supabase
          .from("baileys_auth_state")
          .delete()
          .eq("session_id", sessionId)
          .eq("data_type", type)
          .eq("key_id", id);
    } catch (e) {
        console.error("[AUTH REMOVE ERROR]", e);
    }
  };

  const creds = await readData("creds", "main") || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const res = {};
          // Otimização de leitura: Fazemos Promise.all para ser rápido na leitura
          await Promise.all(ids.map(async (id) => {
            let value = await readData(type, id);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            res[id] = value;
          }));
          return res;
        },
        set: async (data) => {
          const tasks = [];
          
          // 1. Prepara todas as tarefas
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              // Adicionamos a tarefa na lista
              tasks.push(() => value ? writeData(value, type, id) : removeData(type, id));
            }
          }

          // 2. 🔥 EXECUÇÃO EM LOTES (BATCHING) 🔥
          // Isso resolve o erro "fetch failed". Enviamos 50 de cada vez.
          const BATCH_SIZE = 50; 
          for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
            const chunk = tasks.slice(i, i + BATCH_SIZE);
            // Executa 50 tarefas simultâneas e espera elas terminarem antes de mandar as próximas
            await Promise.all(chunk.map(task => task()));
          }
        },
      },
    },
    saveCreds: () => writeData(creds, "creds", "main"),
  };
};
