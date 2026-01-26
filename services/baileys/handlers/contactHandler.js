
import { upsertContact, normalizeJid } from '../../crm/sync.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Processa atualizações de presença (Digitando, Gravando, Online)
 */
export const handlePresenceUpdate = async (presenceUpdate, companyId) => {
    const id = presenceUpdate.id;
    const presences = presenceUpdate.presences;

    if (presences[id]) {
        const lastKnown = presences[id].lastKnownPresence;
        // Considera online se estiver interagindo ou disponível
        const isOnline = lastKnown === 'composing' || lastKnown === 'recording' || lastKnown === 'available';
        
        // Atualiza DB sem travar o processo (Fire & Forget)
        supabase.from('contacts')
            .update({ 
                is_online: isOnline, 
                last_seen_at: new Date().toISOString() 
            })
            .eq('jid', normalizeJid(id))
            .eq('company_id', companyId)
            .then(() => {});
    }
};

/**
 * Processa lista de contatos (Sync inicial ou updates)
 */
export const handleContactsUpsert = async (contacts, companyId) => {
    for (const c of contacts) {
        const jid = normalizeJid(c.id);
        if (!jid) continue;
        
        // Name Hunter: Prioriza nomes reais (notify)
        const bestName = c.name || c.verifiedName || c.notify;
        
        if (bestName || c.imgUrl) {
            await upsertContact(jid, companyId, bestName, c.imgUrl || null, !!c.name, c.lid);
        }
    }
};
