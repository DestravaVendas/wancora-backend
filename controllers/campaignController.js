
import { createClient } from "@supabase/supabase-js";
import { campaignQueue } from "../workers/campaignQueue.js";
import spintax from 'spintax';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const createCampaign = async (req, res) => {
    const { companyId, name, selectedTags, message, scheduledAt } = req.body;

    // Validação básica
    if (!companyId || !name || !message || !selectedTags || !Array.isArray(selectedTags) || selectedTags.length === 0) {
        return res.status(400).json({ error: "Dados da campanha incompletos (Tags obrigatórias)." });
    }

    try {
        console.log(`🚀 [CAMPAIGN] Iniciando criação: "${name}" (Empresa: ${companyId})`);

        // 1. Busca Leads que possuem pelo menos uma das tags (Overlaps)
        // A lógica 'overlaps' garante que se o lead tiver ['VIP', 'SP'] e selecionarmos ['VIP'], ele vem.
        const { data: leads, error: leadsError } = await supabase
            .from('leads')
            .select('id, name, phone')
            .eq('company_id', companyId)
            .overlaps('tags', selectedTags) 
            .neq('status', 'archived'); // Ignora arquivados

        if (leadsError) throw leadsError;

        if (!leads || leads.length === 0) {
            return res.status(404).json({ error: "Nenhum lead encontrado com as tags selecionadas." });
        }

        // 2. Cria Registro da Campanha (Cabeçalho)
        const { data: campaign, error: campError } = await supabase
            .from('campaigns')
            .insert({
                company_id: companyId,
                name,
                message_template: message,
                target_tags: selectedTags,
                status: 'processing', // Já inicia processando se não for agendado
                execution_mode: 'standard',
                stats: { total: leads.length, processed: 0, sent: 0, failed: 0 },
                scheduled_at: scheduledAt || new Date()
            })
            .select()
            .single();

        if (campError) throw campError;

        // 3. Cria Vínculos (Campaign Leads) - Bulk Insert DB
        // Prepara o array de inserção
        const campaignLeads = leads.map(l => ({
            campaign_id: campaign.id,
            lead_id: l.id,
            status: 'pending'
        }));

        // Insere em chunks para evitar limite de payload do Postgrest
        const DB_CHUNK_SIZE = 100;
        for (let i = 0; i < campaignLeads.length; i += DB_CHUNK_SIZE) {
            const chunk = campaignLeads.slice(i, i + DB_CHUNK_SIZE);
            const { error: clError } = await supabase.from('campaign_leads').insert(chunk);
            if (clError) throw clError;
        }

        // 4. Enfileira Jobs no Redis (BullMQ) - Bulk Add Redis
        // CRÍTICO: Também fazemos chunking aqui para não estourar o Redis em campanhas massivas
        const jobs = leads.map(lead => ({
            name: `camp-${campaign.id}-${lead.id}`,
            data: {
                campaignId: campaign.id,
                campaignName: name,
                companyId,
                leadId: lead.id,
                phone: lead.phone,
                leadName: lead.name,
                messageTemplate: message
            },
            opts: {
                removeOnComplete: true, // Remove do Redis se der sucesso para economizar memória
                removeOnFail: { count: 500 } // Mantém logs de falha para debug
            }
        }));

        const REDIS_CHUNK_SIZE = 500;
        for (let i = 0; i < jobs.length; i += REDIS_CHUNK_SIZE) {
            const chunk = jobs.slice(i, i + REDIS_CHUNK_SIZE);
            await campaignQueue.addBulk(chunk);
        }

        console.log(`✅ [CAMPAIGN] Campanha criada e ${jobs.length} jobs enfileirados.`);

        res.status(201).json({ 
            success: true, 
            campaignId: campaign.id, 
            leadsCount: leads.length,
            message: `Campanha iniciada para ${leads.length} leads.`
        });

    } catch (error) {
        console.error("❌ [CAMPAIGN] Erro fatal ao criar:", error);
        res.status(500).json({ error: error.message || "Erro interno ao processar campanha." });
    }
};
