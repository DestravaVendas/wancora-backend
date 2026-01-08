import { BufferJSON } from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export const useSupabaseAuthState = async (sessionId) => {
  const writeData = async (data, type, id) => {
    const payload = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    
    await supabase.from("baileys_auth_state").upsert({
      session_id: sessionId,
      data_type: type,
      key_id: id,
      payload: payload,
      updated_at: new Date()
    }, { onConflict: 'session_id, data_type, key_id' });
  };

  const readData = async (type, id) => {
    const { data, error } = await supabase
      .from("baileys_auth_state")
      .select("payload")
      .eq("session_id", sessionId)
      .eq("data_type", type)
      .eq("key_id", id)
      .single();

    if (error || !data) return null;
    return JSON.parse(JSON.stringify(data.payload), BufferJSON.reviver);
  };

  const removeData = async (type, id) => {
    await supabase
      .from("baileys_auth_state")
      .delete()
      .eq("session_id", sessionId)
      .eq("data_type", type)
      .eq("key_id", id);
  };

  // Carregar credenciais iniciais
  const creds = await readData("creds", "main") || {
    noiseKey: require("@whiskeysockets/baileys").Curve.generateKeyPair(),
    signedIdentityKey: require("@whiskeysockets/baileys").Curve.generateKeyPair(),
    signedPreKey: require("@whiskeysockets/baileys").Curve.generatePreKey(
      require("@whiskeysockets/baileys").Curve.generateKeyPair().private, 1
    ),
    registrationId: Math.floor(Math.random() * 16383),
    advSecretKey: require("crypto").randomBytes(32).toString('base64'),
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSettings: { unarchiveChats: false }
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const res = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(type, id);
            if (type === "app-state-sync-key" && value) {
              value = require("@whiskeysockets/baileys").proto.Message.AppStateSyncKeyData.fromObject(value);
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