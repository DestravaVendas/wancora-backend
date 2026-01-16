
import { Worker } from 'bullmq';
import getRedisClient from '../services/redisClient.js';
import { createClient } from "@supabase/supabase-js";
import pino from 'pino';
import { sendMessage, getSessionId } from '../controllers/whatsappController.js'; 

// Inicializa Supabase (Service Role é ideal aqui para não ser barrado por RLS)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const logger = pino({ level: 'info' });
const connection = getRedisClient();

// --- HELPER: Spintax ---
const spinText = (text) => {
    if (!text) return "";
    return text.replace(/{([^{}]+)}/g, (match, choices) => {
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)];
    });
};

// --- HELPER: Delay ---
const randomDelay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));

// --- HELPER: Atualizar Contadores da Campanha ---
const incrementCampaignStats = async (campaignId, status) => {
    // status: 'success' | 'failed'
    const column = status === 'success' ? 'processed_count' : 'failed_count';
    
    // Chamada RPC atômica seria ideal, mas query direta funciona para MVP
    // Pegamos o valor atual e somamos 1 (Otimista)
    // Nota: Em alta escala, recomenda-se criar uma função RPC 'increment_campaign_counter' no Postgres.
    try {
        const { data } = await supabase.rpc('increment_campaign_count', { 
            p_campaign_id: campaignId, 
            p_field: column 
        });
        
        // Fallback se RPC não existir: (Lento, mas funciona)
        if (!data) {
             const { data: current } = await supabase.from('campaigns').select(column).eq('id', campaignId).single();
             if (current) {
                 await supabase.from('campaigns').update({ [column]: (current[column] || 0) + 1 }).eq('id', campaignId);
             }
        }
    } catch (e) {
        // Silencioso para não parar o worker
        console.error("Erro ao atualizar stats da campanha:", e.message);
    }
};

const worker = new Worker('campaigns', async job => {
    const { companyId, campaignId, lead, messageTemplate } = job.data;

    // 1. Resolve Session ID (Async/Await Critical Fix)
    const sessionId = await getSessionId(companyId);

    if (!sessionId) {
        const errorMsg = `Sessão desconectada para empresa ${companyId}.`;
        await incrementCampaignStats(campaignId, 'failed');
        throw new Error(errorMsg);
    }

    try {
        // 2. Anti-Ban Delay (Smart Throttling)
        // Calcula delay baseado no tamanho da mensagem anterior (simulação simples)
        // Mínimo 15s, Máximo 40s
        const delayMs = Math.floor(Math.random() * (40000 - 15000 + 1) + 15000);
        
        logger.info({ lead: lead.phone, delayMs: delayMs/1000 }, `⏳ Aguardando...`);
        await new Promise(r => setTimeout(r, delayMs));

        // 3. Processa Conteúdo
        let content = spinText(messageTemplate);
        content = content.replace('{{name}}', lead.name || 'Cliente');

        // 4. Envio
        const payload = { type: 'text', text: content };
        await sendMessage(sessionId, lead.phone, payload);

        // 5. Logs e Stats (Sucesso)
        await Promise.all([
            supabase.from('campaign_logs').insert({
                company_id: companyId,
                campaign_id: campaignId,
                lead_id: lead.id,
                phone: lead.phone,
                status: 'sent',
                sent_at: new Date()
            }),
            incrementCampaignStats(campaignId, 'success')
        ]);

        logger.info({ lead: lead.phone }, '✅ Enviado');

    } catch (error) {
        const errorMessage = error?.message || "Erro desconhecido";
        logger.error({ err: errorMessage, phone: lead.phone }, '❌ Falha');
        
        // 6. Logs e Stats (Falha)
        await Promise.all([
            supabase.from('campaign_logs').insert({
                company_id: companyId,
                campaign_id: campaignId,
                lead_id: lead.id,
                phone: lead.phone,
                status: 'failed',
                error_message: errorMessage
            }),
            incrementCampaignStats(campaignId, 'failed')
        ]);

        throw error; 
    }

}, { 
    connection, 
    concurrency: 1, // CRÍTICO: Um envio por vez para evitar banimento
    limiter: {
        max: 1,
        duration: 10000 // Rate limit adicional do BullMQ (1 a cada 10s min)
    }
});

export default worker;
