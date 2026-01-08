import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export const useSupabaseAuthState = async (sessionId) => {
  // Função auxiliar para escrever dados no banco
  const writeData = async (data, type, id) => {
    try {
        // Serializa o buffer para JSON antes de salvar
        const payload = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        
        const { error } = await supabase.from("baileys_auth_state").upsert({
          session_id: sessionId,
          data_type: type,
          key_id: id,
          payload: payload,
          updated_at: new Date()
        }, { onConflict: 'session_id, data_type, key_id' });

        if (error) {
            console.error(`[AUTH ERROR] Falha ao salvar ${type}:`, error.message);
        }
    } catch (e) {
        console.error("[AUTH CRITICAL] Erro no writeData:", e);
    }
  };

  // Função auxiliar para ler dados do banco
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
        // Reconverte o JSON para Buffer
        return JSON.parse(JSON.stringify(data.payload), BufferJSON.reviver);
    } catch (e) {
        console.error("[AUTH READ ERROR]", e);
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

  // Inicializa as credenciais (Se não existir no banco, cria novas)
  console.log(`[AUTH] Carregando credenciais para sessão: ${sessionId}`);
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
              tasks.push(value ? writeData(value, type, id) : removeData(type, id));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds", "main"),
  };
};
