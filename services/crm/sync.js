
import { createClient } from "@supabase/supabase-js";
import { normalizeJid } from "../../utils/wppParsers.js";
import { Logger } from "../../utils/logger.js"; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false },
    db: { schema: 'public' },
    global: { headers: { 'x-my-custom-header': 'wancora-backend' } },
    options: { timeout: 60000 }
});

const leadLock = new Set(); 

const safeSupabaseCall = async (operation, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await operation();
        } catch (error) {
            const msg = error.message || '';
            if (msg.includes('fetch failed') || msg.includes('socket') || msg.includes('timeout')) {
                if (i === retries - 1) throw error; 
                await new Promise(res => setTimeout(res, 1000 * Math.pow(2, i)));
                continue;
            }
            throw error;
        }
    }
};

export { normalizeJid };

const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    if (/^[\d\s\+\-\(\)]*$/.test(cleanName)) return true;
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;
    return !/[a-zA-Z\u00C0-\u00FF]/.test(cleanName);
};

export const updateInstanceStatus = async (sessionId, companyId, data) => {
    try {
        await safeSupabaseCall(() => supabase.from('instances')
            .update({ ...data, updated_at: new Date() })
            .eq('session_id', sessionId)
            .eq('company_id', companyId)
        );
    } catch (e) { }
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await safeSupabaseCall(() => supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId)
        );
    } catch (e) {
        console.error(`❌ [SYNC] Falha ao atualizar status visual:`, e.message);
    }
};

export const upsertContactsBulk = async (contactsArray) => {
    if (!contactsArray || contactsArray.length === 0) return;
    
    const validContacts = contactsArray
        .filter(c => c.jid && c.company_id)
        .map(c => {
            const cleanJid = normalizeJid(c.jid);
            const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
            return { ...c, jid: cleanJid, phone: purePhone };
        });

    if (validContacts.length === 0) return;

    try {
        await safeSupabaseCall(async () => {
            const { error } = await supabase.from('contacts').upsert(validContacts, { onConflict: 'company_id, jid', ignoreDuplicates: false });
            if (error) throw error;
        });
    } catch (e) {
        for (const c of validContacts) {
             try {
                await upsertContact(c.jid, c.company_id, c.name, c.profile_pic_url, !!c.name, null, c.is_business, c.verified_name, { push_name: c.push_name, is_ignored: c.is_ignored });
             } catch (singleErr) {}
        }
    }
};

export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false, lid = null, isBusiness = false, verifiedName = null, extraData = {}) => {
    try {
        if (!jid || !companyId || jid.includes('status@broadcast') || jid.includes('@newsletter')) return;

        const cleanJid = normalizeJid(jid);
        const purePhone = cleanJid.split('@')[0].replace(/\D/g, ''); 
        
        const updateData = { jid: cleanJid, phone: purePhone, company_id: companyId, updated_at: new Date(), ...extraData };

        if (isBusiness) updateData.is_business = true;
        if (verifiedName) updateData.verified_name = verifiedName;

        const nameClean = incomingName ? incomingName.toString().trim() : '';
        const hasValidName = nameClean.length > 0;
        const isGeneric = isGenericName(incomingName, purePhone);

        if (isFromBook && hasValidName) {
            updateData.name = incomingName;
        } else {
             if (hasValidName && !isGeneric) updateData.push_name = incomingName;
        }
        
        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
            updateData.profile_pic_updated_at = new Date(); 
        }

        await safeSupabaseCall(async () => {
            await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });
        });

        if (lid) {
            const cleanLid = normalizeJid(lid);
            if (cleanLid !== cleanJid) {
                supabase.rpc('link_identities', { p_lid: cleanLid, p_phone: cleanJid, p_company_id: companyId }).then(() => {});
            }
        }
    } catch (e) {}
};

export const ensureLeadExists = async (jid, companyId, pushName, myJid) => {
    if (!jid) return null;
    
    const cleanJid = normalizeJid(jid);
    if (!cleanJid) return null;

    if (cleanJid.includes('@g.us') || cleanJid.includes('@newsletter') || cleanJid.includes('status@broadcast')) return null; 
    
    if (myJid) {
        const cleanMyJid = normalizeJid(myJid);
        if (cleanMyJid && cleanJid === cleanMyJid) return null;
    }

    const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
    if (purePhone.length < 8 || purePhone.length > 15) return null;
    
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: contact } = await safeSupabaseCall(() => 
            supabase.from('contacts').select('is_ignored, name, push_name, verified_name').eq('jid', cleanJid).eq('company_id', companyId).maybeSingle()
        );

        if (contact?.is_ignored) return null; 

        let finalName = null;
        if (contact) {
            if (contact.name && !isGenericName(contact.name, purePhone)) finalName = contact.name; 
            else if (contact.verified_name && !isGenericName(contact.verified_name, purePhone)) finalName = contact.verified_name;
            else if (contact.push_name && !isGenericName(contact.push_name, purePhone)) finalName = contact.push_name;
        }
        
        if (!finalName && pushName && !isGenericName(pushName, purePhone)) {
            finalName = pushName;
        }

        const { data: existing } = await safeSupabaseCall(() => 
            supabase.from('leads').select('id, name').eq('phone', purePhone).eq('company_id', companyId).maybeSingle()
        );

        if (existing) {
            const currentNameIsBad = !existing.name || isGenericName(existing.name, purePhone);
            const newNameIsGood = finalName && !isGenericName(finalName, purePhone);

            if (currentNameIsBad && newNameIsGood) {
                await supabase.from('leads').update({ name: finalName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // MUDANÇA AQUI: Removido Logger.info e trocado por console.log para não poluir o painel admin
        // O Monitor Admin deve focar em ERROS, não em sucesso de rotina.
        console.log(`✨ [CRM] Criando novo Lead: ${purePhone} (${finalName || 'Sem Nome'})`);

        if (finalName && isGenericName(finalName, purePhone)) {
            finalName = null;
        }

        const { data: stage } = await supabase.from('pipeline_stages').select('id').eq('company_id', companyId).order('position', { ascending: true }).limit(1).maybeSingle();

        const { data: newLead } = await safeSupabaseCall(() => 
            supabase.from('leads').insert({
                company_id: companyId,
                phone: purePhone,
                name: finalName, 
                status: 'new',
                pipeline_stage_id: stage?.id,
                position: Date.now()
            }).select('id').single()
        );

        return newLead?.id;

    } catch (e) {
        Logger.error('baileys', `Erro ao criar lead ${purePhone}`, { error: e.message }, companyId);
        return null;
    } finally {
        setTimeout(() => leadLock.delete(lockKey), 2000);
    }
};

export const upsertMessage = async (msgData) => {
    try {
        if (msgData.remote_jid.includes('status@broadcast')) return;
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        const finalData = { ...msgData, remote_jid: cleanRemoteJid };

        await safeSupabaseCall(async () => {
            await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        });
    } catch (e) {
        console.error(`❌ [SYNC] Erro upsertMessage:`, e.message);
    }
};

export const updateCampaignStats = async (campaignId, status) => {
    try {
        await supabase.rpc('increment_campaign_count', { p_campaign_id: campaignId, p_field: status });
    } catch (e) { }
};

export const deleteSessionData = async (sessionId, companyId) => {
    await supabase.from('instances').update({ status: 'disconnected', qrcode_url: null }).eq('session_id', sessionId).eq('company_id', companyId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};
