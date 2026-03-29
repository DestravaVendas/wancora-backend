
import { createClient } from "@supabase/supabase-js";
import { aiBus } from "../services/scheduler/sentinel.js";
import { campaignQueue } from "../workers/campaignQueue.js";
import { Logger } from "./logger.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Simula o disparo de uma campanha para N leads fictícios.
 * Valida a fila do BullMQ e o comportamento do Redis.
 */
export const runCampaignStress = async (companyId, count = 500) => {
    console.log(`🚀 [STRESS] Iniciando teste de campanha para ${count} leads...`);
    
    try {
        // 1. Criar uma campanha de teste
        const { data: campaign, error: campError } = await supabase
            .from('campaigns')
            .insert({
                company_id: companyId,
                name: `STRESS TEST - ${new Date().toISOString()}`,
                message_template: "Olá {{name}}, este é um teste de stress do Wancora CRM! 🚀",
                status: 'processing',
                stats: { total: count, processed: 0, sent: 0, failed: 0 }
            })
            .select()
            .single();

        if (campError) throw campError;

        // 2. Gerar leads fictícios em massa (Bulk)
        const dummyLeads = [];
        for (let i = 0; i < count; i++) {
            dummyLeads.push({
                company_id: companyId,
                name: `Lead Stress ${i}`,
                phone: `55119${Math.floor(10000000 + Math.random() * 90000000)}`,
                tags: ['STRESS_TEST']
            });
        }

        const { data: insertedLeads, error: leadsError } = await supabase
            .from('leads')
            .insert(dummyLeads)
            .select('id, name, phone');

        if (leadsError) throw leadsError;

        // 3. Vincular Leads à Campanha (campaign_leads)
        const campaignLeads = insertedLeads.map(lead => ({
            campaign_id: campaign.id,
            lead_id: lead.id,
            status: 'pending'
        }));

        const { error: clError } = await supabase.from('campaign_leads').insert(campaignLeads);
        if (clError) throw clError;

        // 4. Enfileirar no BullMQ
        const jobs = insertedLeads.map(lead => ({
            name: `stress-${campaign.id}-${lead.id}`,
            data: {
                campaignId: campaign.id,
                campaignName: campaign.name,
                companyId,
                leadId: lead.id,
                phone: lead.phone,
                leadName: lead.name,
                messageTemplate: campaign.message_template
            },
            opts: { removeOnComplete: true }
        }));

        const CHUNK_SIZE = 100;
        for (let i = 0; i < jobs.length; i += CHUNK_SIZE) {
            await campaignQueue.addBulk(jobs.slice(i, i + CHUNK_SIZE));
        }

        console.log(`✅ [STRESS] ${count} jobs enfileirados com sucesso.`);
        return { success: true, campaignId: campaign.id, count };
    } catch (error) {
        console.error("❌ [STRESS] Erro no teste de campanha:", error.message);
        throw error;
    }
};

/**
 * Testa a consistência da IA simulando uma conversa de 5 interações.
 */
export const runAIStress = async (companyId, leadId, iterations = 5) => {
    console.log(`🤖 [STRESS] Iniciando teste de consistência da IA...`);
    
    let targetLeadId = leadId;
    let phone = '';

    if (!targetLeadId) {
        // Criar um lead de teste temporário
        const { data: newLead, error: leadError } = await supabase.from('leads').insert({
            company_id: companyId,
            name: 'IA Tester',
            phone: `551199999${Math.floor(1000 + Math.random() * 9000)}`,
            status: 'new'
        }).select().single();

        if (leadError) throw leadError;
        targetLeadId = newLead.id;
        phone = newLead.phone;
    } else {
        const { data: lead } = await supabase.from('leads').select('phone').eq('id', leadId).single();
        if (!lead) throw new Error("Lead não encontrado para teste de IA.");
        phone = lead.phone;
    }

    const remoteJid = `${phone}@s.whatsapp.net`;
    const questions = [
        "Olá, como você funciona?",
        "Quais são os serviços da empresa?",
        "Vocês atendem aos finais de semana?",
        "Pode me enviar um catálogo?",
        "Como faço para agendar uma reunião?"
    ];

    for (let i = 0; i < Math.min(iterations, questions.length); i++) {
        console.log(`   📩 Enviando pergunta ${i+1}: "${questions[i]}"`);
        
        const messageData = {
            whatsapp_id: `stress-ai-${Date.now()}-${i}`,
            content: questions[i],
            remote_jid: remoteJid,
            company_id: companyId,
            from_me: false,
            message_type: 'text',
            created_at: new Date()
        };

        // Dispara o evento que o Sentinel ouve
        aiBus.emit('new_message_arrived', messageData);
        
        // Aguarda um tempo entre as perguntas para simular o tempo de resposta da IA
        // O Sentinel tem delays internos, mas aqui aguardamos para não atropelar o log
        await new Promise(r => setTimeout(r, 15000)); 
    }

    return { success: true, leadId, iterations };
};
