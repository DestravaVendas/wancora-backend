
import { upsertContact, upsertContactsBulk, normalizeJid } from '../../crm/sync.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const presenceDebounce = new Map();

/**
 * Processa atualizações de presença (Online/Visto por ultimo)
 */
export const handlePresenceUpdate = async (presenceUpdate, companyId) => {
    let id = presenceUpdate.id;
    const presences = presenceUpdate.presences;

    // --- LID RESOLVER PARA PRESENÇA ---
    if (id.includes('@lid')) {
        const { data } = await supabase
            .from('identity_map')
            .select('phone_jid')
            .eq('lid_jid', normalizeJid(id))
            .eq('company_id', companyId)
            .maybeSingle();
            
        if (data?.phone_jid) {
            id = data.phone_jid; 
        } else {
            return; 
        }
    }

    const jid = normalizeJid(id);

    if (presences[presenceUpdate.id]) {
        const lastKnown = presences[presenceUpdate.id].lastKnownPresence;
        const isOnline = lastKnown === 'composing' || lastKnown === 'recording' || lastKnown === 'available';
        
        // --- DEBOUNCE PARA EVITAR PISCAR ---
        // O WhatsApp as vezes manda 'unavailable' logo depois de 'available'.
        // Vamos segurar o 'unavailable' por 5 segundos. Se virar 'available' de novo, cancelamos.
        
        if (isOnline) {
            // Se ficou online, limpa qualquer timeout de offline pendente
            if (presenceDebounce.has(jid)) {
                clearTimeout(presenceDebounce.get(jid));
                presenceDebounce.delete(jid);
            }
            
            // Atualiza imediatamente
            supabase.from('contacts')
                .update({ 
                    is_online: true, 
                    last_seen_at: new Date().toISOString() 
                })
                .eq('jid', jid) 
                .eq('company_id', companyId)
                .then(() => {});

        } else {
            // Se ficou offline (unavailable), agenda a atualização
            if (!presenceDebounce.has(jid)) {
                const timeout = setTimeout(() => {
                    supabase.from('contacts')
                        .update({ 
                            is_online: false, 
                            last_seen_at: new Date().toISOString() 
                        })
                        .eq('jid', jid) 
                        .eq('company_id', companyId)
                        .then(() => presenceDebounce.delete(jid));
                }, 5000); // 5 segundos de tolerância

                presenceDebounce.set(jid, timeout);
            }
        }
    }
};

/**
 * Processa lista de contatos (Sync inicial da Agenda - Bulk Version)
 */
export const handleContactsUpsert = async (contacts, companyId) => {
    // Se for um ou dois, faz individual. Se for lote, faz bulk.
    if (!contacts || contacts.length === 0) return;

    if (contacts.length <= 5) {
        for (const c of contacts) {
            const jid = normalizeJid(c.id);
            if (!jid) continue;

            if (c.lid) {
                supabase.rpc('link_identities', {
                    p_lid: normalizeJid(c.lid),
                    p_phone: jid,
                    p_company_id: companyId
                }).then(() => {});
            }

            if (jid.includes('@lid')) continue;

            const bestName = c.name || c.notify || c.verifiedName;
            const isFromBook = !!c.name;

            // Salva sempre, mesmo sem nome, para garantir integridade do ID
            await upsertContact(jid, companyId, bestName, c.imgUrl || null, isFromBook, c.lid);
        }
    } else {
        // BULK PROCESSING PARA A LISTA COMPLETA
        const bulkPayload = [];
        
        for (const c of contacts) {
            const jid = normalizeJid(c.id);
            if (!jid || jid.includes('@lid')) continue;

            const isFromBook = !!c.name;
            const bestName = c.name || c.notify || c.verifiedName;
            
            const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
            
            const contactData = {
                jid: jid,
                phone: purePhone,
                company_id: companyId,
                updated_at: new Date()
            };

            if (isFromBook) contactData.name = bestName;
            else if (bestName) contactData.push_name = bestName;

            if (c.imgUrl) contactData.profile_pic_url = c.imgUrl;
            if (c.verifiedName) {
                contactData.verified_name = c.verifiedName;
                contactData.is_business = true;
            }

            bulkPayload.push(contactData);
        }

        const CHUNK_SIZE = 500;
        for (let i = 0; i < bulkPayload.length; i += CHUNK_SIZE) {
            await upsertContactsBulk(bulkPayload.slice(i, i + CHUNK_SIZE));
        }
    }
};

export const refreshContactInfo = async (sock, jid, companyId, pushName) => {
    if (!jid || jid.includes('status@broadcast')) return;
    const cleanJid = normalizeJid(jid);
    
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

        // Tenta buscar foto se não tiver ou se for velha
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
