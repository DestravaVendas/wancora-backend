import { Worker } from 'bullmq';
import getRedisClient from '../services/redisClient.js';
import { createClient } from "@supabase/supabase-js";
import pino from 'pino';
import { sendMessage, getSessionId } from '../controllers/whatsappController.js'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'info' });
const connection = getRedisClient();

// Jitter (Anti-Ban)
const randomDelay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));

const worker = new Worker('campaigns', async job => {
    const { companyId, campaignId, lead, messageTemplate } = job.data;

    // 1. Busca o ID da sessão via memória (super rápido)
    const sessionId = getSessionId(companyId);

    if (!sessionId) {
        throw new Error(`Sessão não encontrada para empresa ${companyId}. Verifique conexão.`);
    }

    try {
        // 2. Anti-Ban (15s a 45s)
        const delayMs = Math.floor(Math.random() * (45000 - 15000 + 1) + 15000);
        logger.info({ lead: lead.phone, delayMs }, `⏳ Aguardando delay de segurança...`);
        await randomDelay(15000, 45000);

        // 3. Formatação
        const content = messageTemplate.replace('{{name}}', lead.name);

        // 4. Envio (Reutilizando sua lógica)
        await sendMessage(sessionId, lead.phone, content);

        // 5. Log Sucesso
        await supabase.from('campaign_logs').insert({
            company_id: companyId,
            campaign_id: campaignId,
            lead_id: lead.id,
            phone: lead.phone,
            status: 'sent',
            sent_at: new Date()
        });

        logger.info({ lead: lead.phone }, '✅ Mensagem enviada');

    } catch (error) {
        const errorMessage = error?.message || "Erro desconhecido";
        logger.error({ err: errorMessage, phone: lead.phone }, '❌ Falha no envio');
        
        await supabase.from('campaign_logs').insert({
            company_id: companyId,
            campaign_id: campaignId,
            lead_id: lead.id,
            phone: lead.phone,
            status: 'failed',
            error_message: errorMessage
        });

        throw error; // Força retry do BullMQ
    }

}, { 
    connection, 
    concurrency: 5 // Processa 5 mensagens simultâneas (não aumente muito para evitar ban)
});

export default worker;