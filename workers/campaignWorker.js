
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { createClient } from '@supabase/supabase-js';
import { sendMessage } from '../services/baileys/sender.js';
import { getSessionId } from '../controllers/whatsappController.js';
import spintax from 'spintax';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false }});
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

// Helper: Delay Assíncrono
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// O Worker processa os jobs da fila 'campaign-sender'
const worker = new Worker('campaign-sender', async (job) => {
    const { campaignId, companyId, leadId, phone, leadName, messageTemplate } = job.data;

    try {
        console.log(`📤 [WORKER] Processando envio para ${phone} (Job: ${job.id})`);

        // 1. Obter Sessão Ativa
        // Resolvemos o ID da sessão no momento do envio para garantir que usaremos uma conectada
        const sessionId = await getSessionId(companyId);
        if (!sessionId) throw new Error("Sem conexão WhatsApp ativa para esta empresa.");

        // 2. Processar Spintax e Variáveis
        // Ex: {Olá|Oi}, tudo bem? -> Oi, tudo bem?
        let finalMessage = spintax.unspin(messageTemplate);
        
        // Variáveis Dinâmicas
        const firstName = leadName ? leadName.split(' ')[0] : 'Cliente';
        finalMessage = finalMessage.replace(/{{name}}/g, firstName);
        finalMessage = finalMessage.replace(/{{nome}}/g, firstName);

        // 3. Delay de Segurança (Anti-Ban Humanizado)
        // Gera um delay aleatório entre 15s e 45s entre cada mensagem
        // Isso evita padrões mecânicos detectáveis pelo WhatsApp
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

        // 5. Atualizar Status no Banco
        await supabase.from('campaign_leads')
            .update({ status: 'sent', sent_at: new Date() })
            .eq('campaign_id', campaignId)
            .eq('lead_id', leadId);

    } catch (error) {
        console.error(`❌ [WORKER] Falha para ${phone}:`, error.message);
        
        await supabase.from('campaign_leads')
            .update({ status: 'failed', error_log: error.message })
            .eq('campaign_id', campaignId)
            .eq('lead_id', leadId);
            
        throw error;
    }

}, { 
    connection,
    concurrency: 1, // SERIAL: Processa 1 por vez para segurança máxima da conta
    limiter: {
        max: 10, // Máximo 10 jobs
        duration: 10000 // por 10 segundos (Fallback limiter)
    }
});

// Evento de Conclusão do Job
worker.on('completed', async (job) => {
    // Verifica se a campanha inteira acabou
    const { campaignId } = job.data;
    
    // Conta quantos ainda estão pendentes
    const { count } = await supabase.from('campaign_leads')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('status', 'pending');
    
    // Se não há mais pendentes, marca campanha como concluída
    if (count === 0) {
        await supabase.from('campaigns').update({ status: 'completed' }).eq('id', campaignId);
        console.log(`🏁 [CAMPAIGN] Campanha ${campaignId} finalizada com sucesso.`);
    }
});

console.log("👷 [WORKER] Campaign Worker iniciado e aguardando jobs.");
