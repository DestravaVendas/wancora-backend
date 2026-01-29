
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
        // Se 'name' existe, marcamos isFromBook = true
        const bestName = c.name || c.notify || c.verifiedName;
        const isFromBook = !!c.name;

        if (bestName || c.imgUrl) {
            await upsertContact(jid, companyId, bestName, c.imgUrl || null, isFromBook, c.lid);
        }
    }
};

/**
 * SMART FETCHER (Recuperação de Dados Faltantes em Tempo Real)
 * Chamado a cada mensagem recebida para garantir que temos foto e dados business.
 */
export const refreshContactInfo = async (sock, jid, companyId, pushName) => {
    if (!jid || jid.includes('status@broadcast')) return;
    const cleanJid = normalizeJid(jid);
    if (cleanJid.includes('@g.us') || cleanJid.includes('@newsletter')) return;

    try {
        // 1. Consulta o Banco para ver o que falta
        const { data: contact } = await supabase
            .from('contacts')
            .select('profile_pic_url, profile_pic_updated_at, is_business, verified_name')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        const now = new Date();
        const lastUpdate = contact?.profile_pic_updated_at ? new Date(contact.profile_pic_updated_at) : new Date(0);
        const diffHours = (now - lastUpdate) / 1000 / 60 / 60;

        let newPicUrl = null;
        let isBusiness = contact?.is_business || false;
        let verifiedName = contact?.verified_name || null;
        let updated = false;

        // 2. BUSCA PERFIL BUSINESS (Se não temos ou se faz tempo > 48h)
        if (!contact || diffHours > 48) { 
             try {
                 const businessProfile = await sock.getBusinessProfile(cleanJid);
                 if (businessProfile) {
                     isBusiness = true;
                     // Tenta pegar descrição ou email como prova de business, e usa o pushName se verificado não vier explícito
                     verifiedName = businessProfile.description || businessProfile.email ? (pushName || null) : null; 
                     updated = true;
                 }
             } catch (e) {
                 // 404 = Não é business ou erro de rede. Ignora.
             }
        }

        // 3. BUSCA FOTO DE PERFIL (Se antiga ou nula) - Debounce de 24h
        if (!contact?.profile_pic_url || diffHours >= 24) {
            try {
                // 'image' retorna url da imagem em alta resolução se disponível, ou thumb
                newPicUrl = await sock.profilePictureUrl(cleanJid, 'image');
                updated = true;
            } catch (e) {
                // 401/404/400 => Sem foto ou privado.
            }
        }

        // 4. PERSISTE TUDO (Se houve novidade ou se precisamos atualizar o nome)
        // Se 'updated' for true ou se tivermos um pushName novo
        if (updated || pushName) {
            await upsertContact(
                cleanJid, 
                companyId, 
                pushName, // Envia pushName atual como 'incomingName'
                newPicUrl || (updated ? null : undefined), // Se tentou e falhou (null), salva null. Se não tentou (undefined), ignora.
                false, // isFromBook (não é da agenda)
                null, // lid
                isBusiness,
                verifiedName
            );
        }

    } catch (e) {
        console.error(`⚠️ [CONTACT] Erro no refresh info para ${jid}:`, e.message);
    }
};
