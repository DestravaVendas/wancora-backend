
import { upsertContact, normalizeJid } from '../../crm/sync.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Processa atualizações de presença
 */
export const handlePresenceUpdate = async (presenceUpdate, companyId) => {
    const id = presenceUpdate.id;
    const presences = presenceUpdate.presences;

    if (presences[id]) {
        const lastKnown = presences[id].lastKnownPresence;
        const isOnline = lastKnown === 'composing' || lastKnown === 'recording' || lastKnown === 'available';
        
        // Fire & Forget update
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
 * Processa lista de contatos (Sync inicial)
 */
export const handleContactsUpsert = async (contacts, companyId) => {
    for (const c of contacts) {
        const jid = normalizeJid(c.id);
        if (!jid) continue;
        
        const bestName = c.name || c.verifiedName || c.notify;
        
        if (bestName || c.imgUrl) {
            await upsertContact(jid, companyId, bestName, c.imgUrl || null, !!c.name, c.lid);
        }
    }
};

/**
 * SMART FETCHER (Missão 3: Lazy Load)
 * Verifica se precisa baixar a foto de perfil baseada na regra de 24h.
 * Evita chamadas excessivas ao Baileys (Anti-Ban).
 */
export const refreshContactInfo = async (sock, jid, companyId, pushName) => {
    if (!jid || jid.includes('status@broadcast')) return;

    try {
        const cleanJid = normalizeJid(jid);

        // 1. Consulta o Banco
        const { data: contact } = await supabase
            .from('contacts')
            .select('profile_pic_url, profile_pic_updated_at')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        const now = new Date();
        const lastUpdate = contact?.profile_pic_updated_at ? new Date(contact.profile_pic_updated_at) : new Date(0);
        const diffHours = (now - lastUpdate) / 1000 / 60 / 60;

        // REGRA DE OURO: Só busca se for mais velho que 24h ou nunca buscou
        if (diffHours >= 24) {
            let newPicUrl = null;
            try {
                // Baixa do Baileys
                newPicUrl = await sock.profilePictureUrl(cleanJid, 'image');
            } catch (e) {
                // Se falhar (ex: privacidade, bloqueado), não crasha, apenas segue.
                // 401/404/400 são esperados se o usuário não tiver foto
            }

            // Atualiza com timestamp atual (mesmo se null, para resetar o timer de 24h)
            await upsertContact(cleanJid, companyId, pushName, newPicUrl, false);
        } else {
            // Se cache ainda é válido, apenas atualiza o nome se necessário
            // (upsertContact já tem lógica interna para não sobrescrever nomes manuais)
            if (pushName) {
                await upsertContact(cleanJid, companyId, pushName, null, false);
            }
        }

    } catch (e) {
        console.error(`⚠️ [CONTACT] Erro no refresh info para ${jid}:`, e.message);
    }
};
