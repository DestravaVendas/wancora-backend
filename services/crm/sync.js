
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false },
    db: {
        schema: 'public',
    },
    // Configurações globais de fetch para evitar timeouts agressivos
    global: {
        headers: { 'x-my-custom-header': 'wancora-backend' },
    },
});

const leadLock = new Set(); 

// --- UTILS: RETRY WRAPPER ---
// Tenta executar uma operação de banco até 3 vezes antes de falhar
const safeSupabaseCall = async (operation, retries = 3, delay = 500) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await operation();
        } catch (error) {
            const isNetworkError = error.message && (
                error.message.includes('fetch failed') || 
                error.message.includes('socket hang up') ||
                error.message.includes('ETIMEDOUT')
            );

            if (isNetworkError && i < retries - 1) {
                // Wait (Exponential Backoff: 500ms, 1000ms, 2000ms)
                await new Promise(res => setTimeout(res, delay * Math.pow(2, i)));
                continue;
            }
            throw error;
        }
    }
};

// --- HELPERS ---

export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid;
    if (jid.includes('@newsletter')) return jid;
    return jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
};

const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;
    return !/[a-zA-Z\u00C0-\u00FF]/.test(cleanName);
};

// --- CORE SYNC FUNCTIONS ---

export const updateInstanceStatus = async (sessionId, companyId, data) => {
    try {
        await safeSupabaseCall(() => supabase.from('instances')
            .update({ ...data, updated_at: new Date() })
            .eq('session_id', sessionId)
            .eq('company_id', companyId)
        );
    } catch (e) {
        console.error(`❌ [SYNC] Erro updateInstanceStatus:`, e.message);
    }
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await safeSupabaseCall(() => supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId)
        );
    } catch (e) {
        console.error(`❌ [SYNC] Erro updateSyncStatus:`, e.message);
    }
};

export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false, lid = null, isBusiness = false, verifiedName = null) => {
    try {
        if (!jid || !companyId) return;
        if (jid.includes('status@broadcast')) return;

        const cleanJid = normalizeJid(jid);
        const purePhone = cleanJid.split('@')[0].replace(/\D/g, ''); 
        
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date()
        };

        if (isBusiness) updateData.is_business = true;
        if (verifiedName) updateData.verified_name = verifiedName;

        const incomingNameValid = !isGenericName(incomingName, purePhone);

        if (isFromBook && incomingNameValid) {
            updateData.name = incomingName;
        } else if (incomingNameValid) {
            updateData.push_name = incomingName;
        }

        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
            updateData.profile_pic_updated_at = new Date(); 
        }

        if (!isFromBook && !updateData.name) {
            delete updateData.name;
        }

        // WRAPPER DE SEGURANÇA COM RETRY
        await safeSupabaseCall(async () => {
            const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });
            if (error) throw error;
        });

        if (lid) {
            // Non-blocking call
            supabase.rpc('link_identities', { 
                p_lid: normalizeJid(lid), 
                p_phone: cleanJid, 
                p_company_id: companyId 
            }).then(() => {});
        }

        // Atualização de Lead (Opcional, fail silent)
        if (!cleanJid.includes('@g.us') && !cleanJid.includes('@newsletter')) {
            const bestNameAvailable = isFromBook ? incomingName : (verifiedName || incomingName);
            if (bestNameAvailable && !isGenericName(bestNameAvailable, purePhone)) {
                 // Lógica simplificada sem await para não travar o loop
                 supabase.from('leads')
                    .update({ name: bestNameAvailable })
                    .eq('company_id', companyId)
                    .eq('phone', purePhone)
                    .is('name', null) // Só atualiza se for nulo ou genérico (via app logic, aqui simplificado)
                    .then(() => {});
            }
        }

    } catch (e) {
        // Silencia erro de fetch para não poluir log se falhar após retries
        if (!e.message?.includes('fetch failed')) {
            console.error(`❌ [SYNC] Erro upsertContact (${jid}):`, e.message);
        }
    }
};

export const ensureLeadExists = async (jid, companyId, pushName, myJid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return null;
    if (jid.includes('@newsletter')) return null;
    if (jid.includes('status@broadcast')) return null;
    
    const cleanJid = normalizeJid(jid);
    const cleanMyJid = normalizeJid(myJid);
    if (cleanMyJid && cleanJid === cleanMyJid) return null;

    const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
    if (purePhone.length < 8) return null;
    
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: existing } = await safeSupabaseCall(() => 
            supabase.from('leads').select('id').eq('phone', purePhone).eq('company_id', companyId).maybeSingle()
        );

        if (existing) return existing.id;

        // Busca dados de contato para enriquecer
        const { data: contact } = await safeSupabaseCall(() => 
            supabase.from('contacts').select('name, push_name, verified_name').eq('jid', cleanJid).eq('company_id', companyId).maybeSingle()
        );

        let finalName = null;
        if (contact) {
            if (!isGenericName(contact.name, purePhone)) finalName = contact.name;
            else if (!isGenericName(contact.verified_name, purePhone)) finalName = contact.verified_name;
            else if (!isGenericName(contact.push_name, purePhone)) finalName = contact.push_name;
        }

        if (!finalName && pushName && !isGenericName(pushName, purePhone)) {
            finalName = pushName;
        }

        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id').eq('company_id', companyId).order('position', { ascending: true }).limit(1).maybeSingle();

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
        console.error(`❌ [SYNC] Erro ensureLead:`, e.message);
        return null;
    } finally {
        setTimeout(() => leadLock.delete(lockKey), 2000);
    }
};

export const upsertMessage = async (msgData) => {
    try {
        await new Promise(resolve => setTimeout(resolve, 150));
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        const finalData = { ...msgData, remote_jid: cleanRemoteJid };

        await safeSupabaseCall(async () => {
            const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
            if (error) throw error;
        });
        
    } catch (e) {
        console.error(`❌ [SYNC] Erro upsertMessage:`, e.message);
    }
};

export const updateCampaignStats = async (campaignId, status) => {
    try {
        await supabase.rpc('increment_campaign_count', { p_campaign_id: campaignId, p_field: status });
    } catch (e) {}
};

export const deleteSessionData = async (sessionId, companyId) => {
    await supabase.from('instances')
        .update({ status: 'disconnected', qrcode_url: null })
        .eq('session_id', sessionId)
        .eq('company_id', companyId);
        
    await supabase.from('baileys_auth_state')
        .delete()
        .eq('session_id', sessionId);
};
