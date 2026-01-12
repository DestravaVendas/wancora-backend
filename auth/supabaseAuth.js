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
  // Função auxiliar para escrever dados no banco (BLINDADA)
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
            // ESTRATÉGIA ANTI-CRASH:
            // Se der erro de banco (timeout, rate limit), esperamos um pouco e tentamos de novo.
            // Se falhar de novo, APENAS LOGAMOS. Não jogamos erro para o Baileys não desconectar.
            await new Promise(r => setTimeout(r, 1000));
            
            const { error: retryError } = await supabase.from("baileys_auth_state").upsert({
                session_id: sessionId,
                data_type: type,
                key_id: id,
                payload: payload,
                updated_at: new Date()
            }, { onConflict: 'session_id, data_type, key_id' });
            
            if (retryError) {
                console.warn(`[AUTH WARN] Falha não-crítica ao salvar ${type}/${id}. Ignorando para manter conexão.`);
            }
        }
    } catch (e) {
        // Engole o erro de rede para não derrubar o socket
        console.error(`[AUTH SILENT] Erro de rede ao salvar ${type}:`, e.message);
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
          .maybeSingle();

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
          
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              tasks.push(() => value ? writeData(value, type, id) : removeData(type, id));
            }
          }

          // 🔥 EXECUÇÃO EM LOTES (BATCHING SEGURO) 🔥
          // Reduzimos ainda mais para garantir estabilidade em servidores menores
          const BATCH_SIZE = 10; 
          for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
            const chunk = tasks.slice(i, i + BATCH_SIZE);
            await Promise.all(chunk.map(task => task()));
            // Delay vital
            await new Promise(r => setTimeout(r, 50));
          }
        },
      },
    },
    saveCreds: () => writeData(creds, "creds", "main"),
  };
};
