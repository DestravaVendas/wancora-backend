
import { upsertContact, normalizeJid } from '../../crm/sync.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Processa atualizações de presença (Online/Visto por ultimo)
 */
export const handlePresenceUpdate = async (presenceUpdate, companyId) => {
    const id = presenceUpdate.id;
    const presences = presenceUpdate.presences;

    if (presences[id]) {
        const lastKnown = presences[id].lastKnownPresence;
        const isOnline = lastKnown === 'composing' || lastKnown === 'recording' || lastKnown === 'available';
        
        // Update Rápido
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
 * Processa lista de contatos (Sync inicial da Agenda)
 */
export const handleContactsUpsert = async (contacts, companyId) => {
    for (const c of contacts) {
        const jid = normalizeJid(c.id);
        if (!jid) continue;
        
        // Prioridade: name (Agenda) > notify (PushName)
        const bestName = c.name || c.notify || c.verifiedName;
        // isFromBook só é true se 'name' (Agenda do celular) existir
        const isFromBook = !!c.name;

        if (bestName || c.imgUrl) {
            await upsertContact(jid, companyId, bestName, c.imgUrl || null, isFromBook, c.lid);
        }
    }
};

/**
 * SMART FETCHER (Recuperação de Dados Faltantes em Tempo Real)
 * Chamado a cada mensagem recebida via messageHandler.
 * Garante que nomes e fotos sejam atualizados assim que a interação ocorre.
 */
export const refreshContactInfo = async (sock, jid, companyId, pushName) => {
    if (!jid || jid.includes('status@broadcast')) return;
    const cleanJid = normalizeJid(jid);
    if (cleanJid.includes('@g.us') || cleanJid.includes('@newsletter')) return;

    try {
        // 1. Consulta dados atuais
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

        // REGRA DE OURO 1: Se veio um pushName novo e diferente do que temos, atualiza
        if (pushName && pushName.trim() !== '') {
            if (!contact?.push_name || contact.push_name !== pushName) {
                shouldUpdate = true;
            }
        }

        // REGRA DE OURO 2: Verifica Business Profile (Cache 48h)
        if (!contact || diffHours > 48) { 
             try {
                 const businessProfile = await sock.getBusinessProfile(cleanJid);
                 if (businessProfile) {
                     isBusiness = true;
                     // Usa descrição ou email como nome verificado se disponível e se coincidir com pushName (heurística simples)
                     verifiedName = businessProfile.description ? (pushName || null) : null; 
                     shouldUpdate = true;
                 }
             } catch (e) {
                 // 404 = Não é business, segue a vida
             }
        }

        // REGRA DE OURO 3: Busca Foto (Se antiga > 24h ou se não tem)
        // Isso resolve o problema de fotos não aparecerem.
        if (!contact?.profile_pic_url || diffHours >= 24) {
            try {
                // 'image' retorna url da imagem em alta resolução
                newPicUrl = await sock.profilePictureUrl(cleanJid, 'image');
                if (newPicUrl !== contact?.profile_pic_url) {
                    shouldUpdate = true;
                }
            } catch (e) {
                // 401/404 => Sem foto (pode ser privado)
            }
        }

        // 4. Se algo mudou, persistimos tudo
        if (shouldUpdate) {
            // Se não descobrimos foto nova, mantemos a antiga (ou null)
            const finalPic = newPicUrl || contact?.profile_pic_url || null;
            
            // Se não descobrimos nome, tentamos usar o pushName recebido
            const nameToSave = pushName || contact?.push_name;

            await upsertContact(
                cleanJid, 
                companyId, 
                nameToSave, 
                finalPic, 
                false, // isFromBook: false (veio da interação, não da agenda)
                null, 
                isBusiness,
                verifiedName
            );
        }

    } catch (e) {
        console.error(`⚠️ [CONTACT] Erro no refresh info para ${jid}:`, e.message);
    }
};
