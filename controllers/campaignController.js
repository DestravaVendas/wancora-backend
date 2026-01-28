
import { createClient } from "@supabase/supabase-js";
import { campaignQueue } from "../workers/campaignQueue.js"; // IMPORT ADICIONADO
import spintax from 'spintax';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const createCampaign = async (req, res) => {
    const { companyId, name, selectedTags, message, scheduledAt } = req.body;
