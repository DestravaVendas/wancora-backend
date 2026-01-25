import axios from 'axios';
import pino from 'pino';

const logger = pino({ level: 'error' });

export const dispatchWebhook = async (url, event, data) => {
    if (!url) return;

    const payload = {
        event,
        timestamp: new Date().toISOString(),
        data
    };

    try {
        // Timeout curto (3s) para não travar o processamento do Baileys
        await axios.post(url, payload, { timeout: 3000 });
        // console.log(`🪝 [WEBHOOK] Enviado para ${url}`);
    } catch (error) {
        console.error(`❌ [WEBHOOK] Falha ao enviar para ${url}:`, error.message);
    }
};