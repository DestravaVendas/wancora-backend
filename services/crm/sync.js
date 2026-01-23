import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Service Role Key é obrigatória aqui para ignorar RLS e garantir escrita
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'info' }); 

const leadLock = new Set(); 

// --- HELPER: NAME VALIDATION (Name Hunter V5) ---
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    const lower = cleanName.toLowerCase();
    
    if (lower === 'null' || lower === 'undefined' || lower === 'unknown' || lower === 'usuario' || lower === 'contato') return true;
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;

    const hasLetters = /[a-zA-Z\u00C0-\u00FF]/.test(cleanName);
    return !hasLetters; 
};

// --- HELPER: JID NORMALIZATION ---
export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid.split('@')[0] + '@g.us';
    if (jid.includes('@lid')) return jid; 
    return jid.split('@')[0].split(':')[0] + '@s.whatsapp.net';
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

const resolveRealPhone = async (jid, companyId) => {
    if (!jid) return null;
    if (jid.includes('@s.whatsapp.net') && !jid.includes('@lid')) return jid.split('@')[0];
    
    if (jid.includes('@lid')) {
        const { data } = await supabase.from('identity_map')
            .select('phone_jid')
            .eq('lid_jid', jid)
            .eq('company_id', companyId)
            .maybeSingle();
        if (data?.phone_jid) return data.phone_jid.split('@')[0];
    }
    return jid.split('@')[0];
};

// --- CORE: UPSERT CONTACT ---
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false, lidJid = null) => {
    try {
        if (!jid || !companyId) return;
        if (jid.includes('status@broadcast')) return;

        const cleanJid = normalizeJid(jid);
        const isGroup = cleanJid.includes('@g.us');
        
        if (lidJid && !isGroup) {
            await supabase.from('identity_map').upsert({
                lid_jid: normalizeJid(lidJid),
                phone_jid: cleanJid, 
                company_id: companyId
            }, { onConflict: 'lid_jid' });
        }

        let phoneColumnValue = cleanJid.split('@')[0].replace(/\D/g, '');
        if (cleanJid.includes('@lid')) {
            const realPhone = await resolveRealPhone(cleanJid, companyId);
            if (realPhone) phoneColumnValue = realPhone.replace(/\D/g, '');
        }

        const nameIsValid = !isGenericName(incomingName, phoneColumnValue);
        
        const updateData = {
            jid: cleanJid,
            phone: phoneColumnValue,
            company_id: companyId,
            updated_at: new Date()
        };

        if (nameIsValid) {
            updateData.push_name = incomingName;
            if (isFromBook) updateData.name = incomingName;
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        if (!nameIsValid && !profilePicUrl) {
             delete updateData.name;
             delete updateData.push_name;
             delete updateData.profile_pic_url;
        }

        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // Propagação (Anti-Ghost: Só cria se tiver nome válido ou for da agenda)
        if (!error && !isGroup && (nameIsValid || isFromBook)) {
            const realPhoneNum = phoneColumnValue;
            if (realPhoneNum.length < 15) { 
                const { data: lead } = await supabase.from('leads')
                    .select('id, name')
                    .eq('company_id', companyId)
                    .eq('phone', realPhoneNum)
                    .limit(1)
                    .maybeSingle();

                if (lead) {
                    const currentNameIsBad = !lead.name || isGenericName(lead.name, realPhoneNum);
                    if (nameIsValid && (currentNameIsBad || isFromBook)) {
                        await supabase.from('leads').update({ name: incomingName }).eq('id', lead.id);
                    }
                } else if (isFromBook && nameIsValid) {
                    await ensureLeadExists(cleanJid, companyId, incomingName);
                }
            }
        }
    } catch (e) {
        // Silenciar erros de constraint conhecidos
    }
};

// --- CORE: ENSURE LEAD ---
export const ensureLeadExists = async (jid, companyId, pushName, myBotJid = null) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    const cleanJid = normalizeJid(jid);
    
    if (myBotJid) {
        const cleanBot = normalizeJid(myBotJid);
        if (cleanJid === cleanBot) return null;
    }

    const realPhone = await resolveRealPhone(cleanJid, companyId);
    if (!realPhone || (realPhone.length > 14 && !realPhone.startsWith('55'))) return null;

    const lockKey = `${companyId}:${realPhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: existing } = await supabase.from('leads')
            .select('id, name')
            .eq('phone', realPhone)
            .eq('company_id', companyId)
            .maybeSingle();

        const nameIsValid = !isGenericName(pushName, realPhone);
        
        if (existing) {
            if (nameIsValid && (!existing.name || isGenericName(existing.name, realPhone))) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        let finalName = nameIsValid ? pushName : null;
        // Fallback: Busca nome no contato se o pushName for ruim
        if (!finalName) {
            const { data: contact } = await supabase.from('contacts')
                .select('name, push_name')
                .eq('phone', realPhone)
                .eq('company_id', companyId)
                .limit(1)
                .maybeSingle();
            if (contact) {
                if (!isGenericName(contact.name, realPhone)) finalName = contact.name;
                else if (!isGenericName(contact.push_name, realPhone)) finalName = contact.push_name;
            }
        }

        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: realPhone,
            name: finalName,
            status: 'new',
            pipeline_stage_id: stage?.id
        }).select('id').single();

        return newLead?.id;
    } catch (e) {
        return null;
    } finally {
        setTimeout(() => leadLock.delete(lockKey), 1000);
    }
};

// --- CORE: UPSERT MESSAGE (Single) ---
export const upsertMessage = async (msgData) => {
    try {
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        const finalData = { ...msgData, remote_jid: cleanRemoteJid };
        await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
    } catch (e) {
        console.error("Msg Error", e.message);
    }
};

// --- CORE: BULK UPSERT MESSAGES (Alta Performance) ---
export const upsertMessagesBatch = async (messagesArray) => {
    if (!messagesArray || messagesArray.length === 0) return;
    
    try {
        // Normaliza JIDs no lote
        const finalData = messagesArray.map(m => ({
            ...m,
            remote_jid: normalizeJid(m.remote_jid)
        }));

        // Upsert Gigante (Supabase aceita array no insert/upsert)
        const { error } = await supabase
            .from('messages')
            .upsert(finalData, { onConflict: 'remote_jid, whatsapp_id', ignoreDuplicates: true });
            
        if (error) throw error;
        
        console.log(`🚀 [PERFORMANCE] Lote de ${messagesArray.length} mensagens salvo.`);
    } catch (e) {
        console.error(`❌ [SYNC BATCH ERROR]`, e.message);
    }
};

export const savePollVote = async (msg, companyId) => {};
export const deleteSessionData = async (sessionId) => {
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};
export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
