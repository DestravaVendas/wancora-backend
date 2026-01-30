
import { createClient } from "@supabase/supabase-js";

// Configurações do Cliente Supabase para evitar Timeouts
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false },
    db: { schema: 'public' },
    global: {
        headers: { 'x-my-custom-header': 'wancora-backend' },
    },
    // Aumenta timeouts internos
    options: {
        timeout: 60000 
    }
});

const leadLock = new Set(); 

// WRAPPER DE RETRY (Com backoff maior)
const safeSupabaseCall = async (operation, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await operation();
        } catch (error) {
            const msg = error.message || '';
            if (msg.includes('fetch failed') || msg.includes('socket') || msg.includes('timeout') || msg.includes('503') || msg.includes('502')) {
                if (i === retries - 1) throw error; 
                await new Promise(res => setTimeout(res, 1000 * Math.pow(2, i)));
                continue;
            }
            throw error;
        }
    }
};

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

export const updateInstanceStatus = async (sessionId, companyId, data) => {
    try {
        await safeSupabaseCall(() => supabase.from('instances')
            .update({ ...data, updated_at: new Date() })
            .eq('session_id', sessionId)
            .eq('company_id', companyId)
        );
    } catch (e) {
        // Fail silent para não parar fluxo
    }
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await safeSupabaseCall(() => supabase.from('instances')
            .update({ 
                sync_status: status, 
                sync_percent: percent, 
                updated_at: new Date() 
            })
            .eq('session_id', sessionId)
        );
    } catch (e) {
        console.error(`❌ [SYNC] Falha ao atualizar status visual:`, e.message);
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

        await safeSupabaseCall(async () => {
            const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });
            if (error) throw error;
        });

        if (lid) {
            supabase.rpc('link_identities', { 
                p_lid: normalizeJid(lid), 
                p_phone: cleanJid, 
                p_company_id: companyId 
            }).then(() => {});
        }

    } catch (e) {
        // Erro silencioso
    }
};

// --- GUARDIÃO DE LEADS (The Gatekeeper) ---
export const ensureLeadExists = async (jid, companyId, pushName, myJid) => {
    // 1. REGRAS DE EXCLUSÃO (Hard Rules)
    if (!jid) return null;
    if (jid.includes('@g.us')) return null; // Grupos não viram Leads
    if (jid.includes('@newsletter')) return null; // Canais não viram Leads
    if (jid.includes('status@broadcast')) return null; // Status não vira Lead
    
    const cleanJid = normalizeJid(jid);
    
    // Auto-exclusão (Não cria lead para mim mesmo)
    if (myJid) {
        const cleanMyJid = normalizeJid(myJid);
        // Compara apenas os números para evitar divergência de sufixo/server
        const myNum = cleanMyJid?.split('@')[0];
        const targetNum = cleanJid?.split('@')[0];
        if (myNum && targetNum && myNum === targetNum) return null;
    }

    const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
    if (purePhone.length < 8) return null;
    
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        // 2. VERIFICAÇÃO DE "REMOVIDO DO CRM" (is_ignored)
        // Se o contato existe e está ignorado, aborta imediatamente.
        const { data: contact } = await safeSupabaseCall(() => 
            supabase.from('contacts')
                .select('is_ignored, name, push_name, verified_name')
                .eq('jid', cleanJid)
                .eq('company_id', companyId)
                .maybeSingle()
        );

        if (contact?.is_ignored) {
            // console.log(`🚫 [SYNC] Contato ${purePhone} ignorado. Lead não criado.`);
            return null;
        }

        // 3. VERIFICAÇÃO DE LEAD EXISTENTE
        const { data: existing } = await safeSupabaseCall(() => 
            supabase.from('leads').select('id').eq('phone', purePhone).eq('company_id', companyId).maybeSingle()
        );

        if (existing) return existing.id;

        // 4. PREPARAÇÃO DO NOME (Hierarquia)
        let finalName = null;
        if (contact) {
            if (!isGenericName(contact.name, purePhone)) finalName = contact.name;
            else if (!isGenericName(contact.verified_name, purePhone)) finalName = contact.verified_name;
            else if (!isGenericName(contact.push_name, purePhone)) finalName = contact.push_name;
        }
        
        // Fallback para pushName vindo do evento, se o do banco for ruim
        if (!finalName && pushName && !isGenericName(pushName, purePhone)) {
            finalName = pushName;
        }

        // Se ainda não tiver nome, usa o número formatado como último recurso
        if (!finalName) {
            finalName = `+${purePhone}`;
        }

        // 5. CRIAÇÃO DO LEAD
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
        return null;
    } finally {
        setTimeout(() => leadLock.delete(lockKey), 2000);
    }
};

export const upsertMessage = async (msgData) => {
    try {
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
