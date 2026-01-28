
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { createClient } from "@supabase/supabase-js";
import { sendMessage } from '../services/baileys/sender.js';
import { getSessionId } from '../controllers/whatsappController.js';
import { updateCampaignStats } from '../services/crm/sync.js';
import { delay } from '@whiskeysockets/baileys';
import spintax from 'spintax';

// Conexão Redis para o Worker
const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null
});

// Cliente Supabase Service Role
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Helper para Spintax
const parseSpintax = (text) => {
    if(!text) return "";
    return spintax.unspin(text);
};

// O Worker processa os jobs da fila 'campaign-sender'
const worker = new Worker('campaign-sender', async (job) => {
    const { campaignId, campaignName, companyId, leadId, phone, leadName, messageTemplate } = job.data;

    try {
        console.log(`📤 [WORKER] Processando envio para ${phone} (Job: ${job.id})`);

        // 1. Obter Sessão Ativa
        const sessionId = await getSessionId(companyId);
        if (!sessionId) throw new Error("Sem conexão WhatsApp ativa para esta empresa.");

        // 2. Processar Spintax e Variáveis
        let finalMessage = parseSpintax(messageTemplate);
        
        // Variáveis Dinâmicas
        const firstName = leadName ? leadName.split(' ')[0] : 'Cliente';
        finalMessage = finalMessage.replace(/{{name}}/g, firstName);
        finalMessage = finalMessage.replace(/{{nome}}/g, firstName);
        finalMessage = finalMessage.replace(/{{phone}}/g, phone);

        // 3. Delay de Segurança (Anti-Ban Humanizado)
        // Gera um delay aleatório entre 15s e 45s
        const waitTime = Math.floor(Math.random() * (45000 - 15000 + 1) + 15000);
        console.log(`⏳ [WORKER] Aguardando ${waitTime}ms para humanização...`);
        await delay(waitTime);

        // 4. Enviar Mensagem
        await sendMessage({
            sessionId,
            to: phone,
            type: 'text',
            content: finalMessage
        });

        // 5. Atualizar Status no Banco e Stats da Campanha
        await supabase.from('campaign_leads')
            .update({ status: 'sent', sent_at: new Date() })
            .eq('campaign_id', campaignId)
            .eq('lead_id', leadId);
            
        await updateCampaignStats(campaignId, 'sent');

        // 6. LOG NA TIMELINE DO LEAD (NOVO)
        // Isso garante que o vendedor veja que a campanha foi enviada no histórico do cliente
        await supabase.from('lead_activities').insert({
            company_id: companyId,
            lead_id: leadId,
            type: 'log',
            content: `📢 Campanha Enviada: "${campaignName || 'Disparo em Massa'}"`,
            created_at: new Date()
        });

    } catch (error) {
        console.error(`❌ [WORKER] Falha para ${phone}:`, error.message);
        
        await supabase.from('campaign_leads')
            .update({ status: 'failed', error_log: error.message })
            .eq('campaign_id', campaignId)
            .eq('lead_id', leadId);
            
        await updateCampaignStats(campaignId, 'failed');
            
        throw error;
    }

}, { 
    connection,
    concurrency: 1, // SERIAL: Processa 1 por vez para segurança máxima
    limiter: {
        max: 5, // Reduzido para 5 jobs
        duration: 10000 // a cada 10s (Limite Global)
    }
});
