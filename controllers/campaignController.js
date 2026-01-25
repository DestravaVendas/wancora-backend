
import { createClient } from "@supabase/supabase-js";
import { campaignQueue } from "../workers/campaignQueue.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export const createCampaign = async (req, res) => {
    const { companyId, name, message, selectedTags, scheduledAt } = req.body;

    if (!companyId || !message || !selectedTags || selectedTags.length === 0) {
        return res.status(400).json({ error: "Dados inválidos: Tags e Mensagem são obrigatórios." });
    }

    try {
        console.log(`🚀 [CAMPAIGN] Iniciando criação: "${name}" Tags: [${selectedTags.join(', ')}]`);

        // 1. Criar Registro da Campanha (Cabeçalho)
        const { data: campaign, error: campError } = await supabase
            .from('campaigns')
            .upsert({
                company_id: companyId,
                name,
                message_template: message,
                target_tags: selectedTags,
                status: 'processing', // Já inicia processando
                scheduled_at: scheduledAt || new Date().toISOString()
            })
            .select()
            .single();

        if (campError) throw campError;

        // 2. Buscar Leads Alvo (Intersection)
        // Busca leads que tenham pelo menos uma das tags selecionadas
        const { data: leads, error: leadsError } = await supabase
            .from('leads')
            .select('id, name, phone')
            .eq('company_id', companyId)
            .contains('tags', selectedTags);

        if (leadsError) throw leadsError;

        if (!leads || leads.length === 0) {
            await supabase.from('campaigns').update({ status: 'completed' }).eq('id', campaign.id);
            return res.json({ success: true, message: "Nenhum lead encontrado com as tags selecionadas.", campaignId: campaign.id });
        }

        // 3. Adicionar Jobs na Fila (Bulk Insert no Redis)
        const jobs = leads.map(lead => ({
            name: `campaign-${campaign.id}-${lead.id}`,
            data: {
                campaignId: campaign.id,
                companyId,
                leadId: lead.id,
                phone: lead.phone,
                leadName: lead.name,
                messageTemplate: message
            },
            opts: {
                removeOnComplete: true, // Limpa o Redis após sucesso
                removeOnFail: 500 // Mantém histórico de erro
            }
        }));

        await campaignQueue.addBulk(jobs);

        // 4. Registrar itens na tabela de controle para a UI acompanhar
        const campaignLeadsData = leads.map(lead => ({
            campaign_id: campaign.id,
            lead_id: lead.id,
            status: 'pending'
        }));
        
        await supabase.from('campaign_leads').insert(campaignLeadsData);

        res.json({ 
            success: true, 
            campaignId: campaign.id, 
            leadsCount: leads.length,
            message: `Campanha iniciada! ${leads.length} mensagens na fila.` 
        });

    } catch (error) {
        console.error("❌ Erro ao criar campanha:", error);
        res.status(500).json({ error: error.message });
    }
};
