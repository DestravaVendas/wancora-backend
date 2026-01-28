
import axios from 'axios';
import { createClient } from "@supabase/supabase-js";

// Cliente Supabase Service Role para logs
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const dispatchWebhook = async (url, event, data, instanceId) => {
    if (!url) return;

    const payload = {
        event,
        timestamp: new Date().toISOString(),
        data
    };

    let status = 0;
    let responseBody = '';

    try {
        // Timeout curto (3s) para não travar o processamento do Baileys
        const res = await axios.post(url, payload, { timeout: 3000 });
        status = res.status;
        responseBody = JSON.stringify(res.data).substring(0, 1000); // Trunca para economizar espaço
        
        // console.log(`🪝 [WEBHOOK] Enviado para ${url} (Status: ${status})`);
    } catch (error) {
        status = error.response ? error.response.status : 500;
        responseBody = error.message;
        console.error(`❌ [WEBHOOK] Falha ao enviar para ${url}:`, error.message);
    } finally {
        // Grava log no banco se tivermos o instanceId (Compliance com DATABASE_SCHEMA)
        if (instanceId) {
            await supabase.from('webhook_logs').insert({
                instance_id: instanceId,
                event_type: event,
                status: status,
                payload: payload,
                response_body: responseBody,
                created_at: new Date()
            }).catch(e => console.error("Erro ao salvar log de webhook:", e.message));
        }
    }
};
