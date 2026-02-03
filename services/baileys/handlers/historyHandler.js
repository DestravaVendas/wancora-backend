
import { upsertContact, normalizeJid } from '../../crm/sync.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Processa atualizações de presença (Online/Visto por ultimo)
 */
export const handlePresenceUpdate = async (presenceUpdate, companyId) => {
    let id = presenceUpdate.id;
    const presences = presenceUpdate.presences;

    // --- LID RESOLVER PARA PRESENÇA ---
    // Se o ID for um LID, buscamos o telefone real na tabela identity_map
    // para marcar online o chat correto (Telefone), não o dispositivo (LID).
    if (id.includes('@lid')) {
        const { data } = await supabase
            .from('identity_map')
            .select('phone_jid')
            .eq('lid_jid', normalizeJid(id))
            .eq('company_id', companyId)
            .maybeSingle();
            
        if (data?.phone_jid) {
            id = data.phone_jid; // Redireciona para o JID do telefone
        } else {
            // Se não achou mapeamento, ABORTA. 
            // Não queremos atualizar status de um LID desconhecido na tabela contacts.
            return; 
        }
    }

    if (presences[presenceUpdate.id]) {
        const lastKnown = presences[presenceUpdate.id].lastKnownPresence;
        const isOnline = lastKnown === 'composing' || lastKnown === 'recording' || lastKnown === 'available';
        
        // Update Rápido no ID resolvido (Telefone)
        supabase.from('contacts')
            .update({ 
                is_online: isOnline, 
                last_seen_at: new Date().toISOString() 
            })
            .eq('jid', normalizeJid(id)) // Usa o ID resolvido (Telefone)
            .eq('company_id', companyId)
            .then(() => {});
    }
};

/**
 * Processa lista de contatos (Sync inicial da Agenda)
 */
export const handleContactsUpsert = async (contacts, companyId) => {
    for (const c of contacts) {
        const jid = normalizeJid(c.id);
        if (!jid) continue;

        // Mapeamento de Identidade (LID -> Phone)
        // O Baileys geralmente envia o objeto com { id: 'phone_jid', lid: 'lid_jid' }
        if (c.lid) {
            supabase.rpc('link_identities', {
                p_lid: normalizeJid(c.lid),
                p_phone: jid,
                p_company_id: companyId
            }).then(() => {});
        }

        // --- FILTRO DE HIGIENE ---
        // Se o PRÓPRIO contato for um LID (ex: upsert de dispositivo), ignoramos na lista visual.
        // Só queremos salvar contatos de telefone (@s.whatsapp.net) ou grupos (@g.us).
        if (jid.includes('@lid')) continue;

        const bestName = c.name || c.notify || c.verifiedName;
        const isFromBook = !!c.name;

        if (bestName || c.imgUrl) {
            await upsertContact(jid, companyId, bestName, c.imgUrl || null, isFromBook, c.lid);
        }
    }
};

export const refreshContactInfo = async (sock, jid, companyId, pushName) => {
    if (!jid || jid.includes('status@broadcast')) return;
    const cleanJid = normalizeJid(jid);
    
    // Ignora LIDs, Grupos e Canais para refresh de perfil comercial
    if (cleanJid.includes('@lid') || cleanJid.includes('@g.us') || cleanJid.includes('@newsletter')) return;

    try {
        const { data: contact } = await supabase
            .from('contacts')
            .select('profile_pic_url, profile_pic_updated_at, is_business, verified_name, name, push_name')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        const now = new Date();
        const lastUpdate = contact?.profile_pic_updated_at ? new Date(contact.profile_pic_updated_at) : new Date(0);
        const diffHours = (now - lastUpdate) / 1000 / 60 / 60;

        let newPicUrl = null;
        let isBusiness = contact?.is_business || false;
        let verifiedName = contact?.verified_name || null;
        let shouldUpdate = false;

        if (pushName && pushName.trim() !== '') {
            if (!contact?.push_name || contact.push_name !== pushName) {
                shouldUpdate = true;
            }
        }

        if (!contact || diffHours > 48) { 
             try {
                 const businessProfile = await sock.getBusinessProfile(cleanJid);
                 if (businessProfile) {
                     isBusiness = true;
                     verifiedName = businessProfile.description ? (pushName || null) : null; 
                     shouldUpdate = true;
                 }
             } catch (e) {}
        }

        if (!contact?.profile_pic_url || diffHours >= 24) {
            try {
                newPicUrl = await sock.profilePictureUrl(cleanJid, 'image');
                if (newPicUrl !== contact?.profile_pic_url) {
                    shouldUpdate = true;
                }
            } catch (e) {}
        }

        if (shouldUpdate) {
            const finalPic = newPicUrl || contact?.profile_pic_url || null;
            const nameToSave = pushName || contact?.push_name;

            await upsertContact(
                cleanJid, 
                companyId, 
                nameToSave, 
                finalPic, 
                false, 
                null, 
                isBusiness,
                verifiedName
            );
        }

    } catch (e) {
        console.error(`⚠️ [CONTACT] Erro no refresh info para ${jid}:`, e.message);
    }
};
