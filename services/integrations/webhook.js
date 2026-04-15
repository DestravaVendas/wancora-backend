
import axios from 'axios';
import crypto from 'crypto';
import { createClient } from "@supabase/supabase-js";

// Cliente Supabase Service Role para logs
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

/**
 * Gera a assinatura HMAC-SHA256 do payload serializado.
 * Formato: sha256=<hex_digest>
 * Compatível com GitHub Webhooks / Stripe signature style.
 * 
 * @param {string} payloadString - JSON.stringify do payload a ser enviado
 * @param {string} secret - Chave secreta compartilhada (WEBHOOK_SIGNING_SECRET)
 * @returns {string} Assinatura no formato "sha256=<hex>"
 */
const generateHmacSignature = (payloadString, secret) => {
    return 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(payloadString, 'utf8')
        .digest('hex');
};

export const dispatchWebhook = async (url, event, data, instanceId) => {
    if (!url) return;

    const payload = {
        event,
        timestamp: new Date().toISOString(),
        data
    };

    // Serializa uma única vez — mesma string que será assinada E enviada
    // Garante que assinatura e corpo são identicamente consistentes
    const payloadString = JSON.stringify(payload);

    let status = 0;
    let responseBody = '';

    // Monta os headers base
    const headers = {
        'Content-Type': 'application/json',
    };

    // Adiciona assinatura HMAC se o secret estiver configurado
    const signingSecret = process.env.WEBHOOK_SIGNING_SECRET;
    if (signingSecret) {
        headers['X-Wancora-Signature'] = generateHmacSignature(payloadString, signingSecret);
        headers['X-Wancora-Timestamp'] = payload.timestamp; // Útil para o receptor rejeitar replays antigos
    } else {
        console.warn('⚠️ [WEBHOOK] WEBHOOK_SIGNING_SECRET não configurado. Webhook enviado SEM assinatura HMAC.');
    }

    try {
        // Envia o body já serializado (string) para garantir consistência com a assinatura
        // Timeout curto (3s) para não travar o processamento do Baileys
        const res = await axios.post(url, payloadString, { headers, timeout: 3000 });
        status = res.status;
        responseBody = JSON.stringify(res.data).substring(0, 1000); // Trunca para economizar espaço

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

/**
 * Valida a assinatura HMAC de um webhook recebido.
 * Use esta função no receptor para verificar a autenticidade.
 * 
 * @param {string} rawBody - Body cru da requisição (string, não parseado)
 * @param {string} signatureHeader - Valor do header X-Wancora-Signature
 * @param {string} secret - Chave secreta (WEBHOOK_SIGNING_SECRET)
 * @returns {boolean}
 */
export const verifyWebhookSignature = (rawBody, signatureHeader, secret) => {
    if (!signatureHeader || !secret) return false;
    const expected = generateHmacSignature(rawBody, secret);
    // timingSafeEqual previne timing attacks na comparação de strings
    try {
        return crypto.timingSafeEqual(
            Buffer.from(expected, 'utf8'),
            Buffer.from(signatureHeader, 'utf8')
        );
    } catch {
        return false;
    }
};
