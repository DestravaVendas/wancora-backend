import { createClient } from "@supabase/supabase-js";
import { dispatchCampaign } from "../workers/campaignQueue.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export const createCampaign = async (req, res) => {
    const { companyId, name, message, selectedTags } = req.body;

    if (!companyId || !message || !name) {
        return res.status(400).json({ error: "Dados incompletos." });
    }

    try {
        // 1. Registra Campanha
        const { data: campaign, error: campError } = await supabase
            .from('campaigns')
            .insert({
                company_id: companyId,
                name,
                message_template: message,
                target_tags: selectedTags || [],
                status: 'processing',
                created_at: new Date()
            })
            .select()
            .single();

        if (campError) throw campError;

        // 2. Busca Leads (Com filtro de Tags)
        let query = supabase
            .from('leads')
            .select('id, contact_jid, phone, name, tags')
            .eq('company_id', companyId);

        if (selectedTags && selectedTags.length > 0) {
            // Postgres 'overlaps': Se tiver qualquer uma das tags
            query = query.overlaps('tags', selectedTags);
        }

        const { data: leads, error: leadsError } = await query;
        if (leadsError) throw leadsError;

        // 3. Sanitiza Lista
        const validLeads = leads
            .filter(l => l.contact_jid || l.phone)
            .map(l => ({
                id: l.id,
                name: l.name || 'Cliente',
                phone: (l.contact_jid || l.phone).replace('@s.whatsapp.net', '') 
            }));

        if (validLeads.length === 0) {
            await supabase.from('campaigns').update({ status: 'completed' }).eq('id', campaign.id);
            return res.status(400).json({ error: "Nenhum lead encontrado para os filtros." });
        }

        // 4. Dispara
        await dispatchCampaign(companyId, campaign.id, validLeads, message);

        return res.status(200).json({ 
            success: true, 
            message: `Campanha iniciada para ${validLeads.length} contatos.`,
            campaignId: campaign.id 
        });

    } catch (error) {
        console.error("Erro campanha:", error);
        res.status(500).json({ error: "Erro interno." });
    }
};