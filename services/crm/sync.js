
import { createClient } from "@supabase/supabase-js";
import { normalizeJid } from '../../utils/wppParsers.js'; 
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const leadLock = new Set(); 

// --- HELPERS ---

// Valida se o nome é genérico (número de telefone, vazio ou inválido)
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    if (/^[\d\s\+\-\(\)]+$/.test(cleanName)) return true;
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;
    return !/[a-zA-Z\u00C0-\u00FF]/.test(cleanName);
};

// --- CORE SYNC FUNCTIONS ---

export const updateInstanceStatus = async (sessionId, companyId, data) => {
    await supabase.from('instances')
        .update({ ...data, updated_at: new Date() })
        .eq('session_id', sessionId)
        .eq('company_id', companyId);
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {
        console.error(`❌ [SYNC] Erro status:`, e.message);
    }
};

export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false, lid = null) => {
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

        const incomingNameValid = !isGenericName(incomingName, purePhone);

        const { data: existingContact } = await supabase.from('contacts')
            .select('name, push_name')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        if (isFromBook) {
            updateData.name = incomingNameValid ? incomingName : null;
        } else {
            if (incomingNameValid) {
                updateData.push_name = incomingName;
                if (!existingContact || !existingContact.name) {
                    updateData.name = incomingName;
                }
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });
        if (error) throw error;

        if (lid) {
            supabase.rpc('link_identities', { 
                p_lid: normalizeJid(lid), 
                p_phone: cleanJid, 
                p_company_id: companyId 
            }).then(() => {});
        }

    } catch (e) {
        console.error(`❌ [SYNC] Erro upsertContact:`, e.message);
    }
};

export const ensureLeadExists = async (jid, companyId, pushName, myJid) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 
    if (myJid && normalizeJid(jid) === normalizeJid(myJid)) return null;

    const cleanJid = normalizeJid(jid);
    const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
    
    if (purePhone.length < 8) return null;
    
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        // 1. Verifica existência
        const { data: existing } = await supabase.from('leads')
            .select('id, name')
            .eq('phone', purePhone)
            .eq('company_id', companyId)
            .maybeSingle();

        const nameIsValid = !isGenericName(pushName, purePhone);
        
        if (existing) {
            // Self-Healing: Atualiza nome se tivermos um melhor
            if (nameIsValid && isGenericName(existing.name, purePhone)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 2. Determina Nome (Fallback para Telefone Formatado se não tiver nome)
        let finalName = nameIsValid ? pushName : `+${purePhone}`;
        
        // Tenta buscar no contato salvo se o pushName for ruim
        if (!nameIsValid) {
            const { data: contact } = await supabase.from('contacts')
                .select('name, push_name')
                .eq('jid', cleanJid)
                .eq('company_id', companyId)
                .maybeSingle();

            if (contact) {
                if (!isGenericName(contact.name, purePhone)) finalName = contact.name; 
                else if (!isGenericName(contact.push_name, purePhone)) finalName = contact.push_name; 
            }
        }

        // 3. Pega Funil Padrão
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        // 4. CRIAÇÃO FORÇADA DE LEAD (Auto-Lead)
        console.log(`⚡ [AUTO-LEAD] Criando lead para ${purePhone} (${finalName})`);
        
        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: purePhone,
            name: finalName,
            status: 'new',
            pipeline_stage_id: stage?.id,
            position: Date.now()
        }).select('id').single();

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
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        const finalData = { ...msgData, remote_jid: cleanRemoteJid };

        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
        
        // Garante que o contato existe e atualiza last_message_at
        const { error: contactError } = await supabase.from('contacts').upsert({
            jid: cleanRemoteJid,
            company_id: msgData.company_id,
            last_message_at: msgData.created_at,
            phone: cleanRemoteJid.split('@')[0].replace(/\D/g, '')
        }, { onConflict: 'company_id, jid', ignoreDuplicates: false }); 

        if (contactError) console.error("Erro update contact last_message:", contactError.message);
        
    } catch (e) {
        console.error(`❌ [SYNC] Erro upsertMessage:`, e.message);
    }
};

export const updateCampaignStats = async (campaignId, status) => {
    try { await supabase.rpc('increment_campaign_count', { p_campaign_id: campaignId, p_field: status }); } catch (e) {}
};

export const deleteSessionData = async (sessionId, companyId) => {
    await supabase.from('instances').update({ status: 'disconnected', qrcode_url: null }).eq('session_id', sessionId).eq('company_id', companyId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};

export { normalizeJid };
