
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
    // Removido suporte a newsletter
    const clean = jid.split(':')[0];
    return clean.includes('@') ? clean : `${clean}@s.whatsapp.net`;
};

// Validador Estrito de Nomes (Anti-Spam)
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    
    // Se for só números ou símbolos: generic
    if (/^[\d\s\+\-\(\)]*$/.test(cleanName)) return true;

    // Se for igual ao telefone: generic
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;
    
    // Se não tiver pelo menos uma letra: generic
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
        // Fail silent
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

export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false, lid = null, isBusiness = false, verifiedName = null, extraData = {}) => {
    try {
        if (!jid || !companyId) return;
        if (jid.includes('status@broadcast')) return; 
        if (jid.includes('@newsletter')) return;

        const cleanJid = normalizeJid(jid);
        if (!cleanJid) return;

        const purePhone = cleanJid.split('@')[0].replace(/\D/g, ''); 
        
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date(),
            ...extraData
        };

        if (isBusiness) updateData.is_business = true;
        if (verifiedName) updateData.verified_name = verifiedName;

        const nameClean = incomingName ? incomingName.toString().trim() : '';
        const hasValidName = nameClean.length > 0;
        
        // Verifica se é genérico (números, simbolos)
        const isGeneric = isGenericName(incomingName, purePhone);

        // LÓGICA "TRUST THE BOOK":
        // 1. Se veio da Agenda (isFromBook) E tem texto -> Salva em 'name' (Ignora filtro de genérico).
        //    Motivo: Se o usuário salvou "123" ou "❤️", ele quer ver isso.
        // 2. Se veio de PushName (Automático) -> Salva em 'push_name' APENAS se não for genérico.
        
        if (isFromBook && hasValidName) {
            updateData.name = incomingName;
        } else if (hasValidName && !isGeneric) {
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

// --- GUARDIÃO DE LEADS ---
// trustName: Se true, ignora isGenericName para o pushName (útil quando vem da agenda)
export const ensureLeadExists = async (jid, companyId, pushName, myJid, trustName = false) => {
    if (!jid) return null;
    
    if (jid.includes('@lid')) return null;
    if (jid.includes('@g.us')) return null; 
    if (jid.includes('@newsletter')) return null; 
    if (jid.includes('status@broadcast')) return null; 
    
    const cleanJid = normalizeJid(jid);
    
    if (myJid) {
        const cleanMyJid = normalizeJid(myJid);
        const myNum = cleanMyJid?.split('@')[0];
        const targetNum = cleanJid?.split('@')[0];
        if (myNum && targetNum && myNum === targetNum) return null;
    }

    const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
    
    if (purePhone.length < 8 || purePhone.length > 15) {
        return null;
    }
    
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: contact } = await safeSupabaseCall(() => 
            supabase.from('contacts')
                .select('is_ignored, name, push_name, verified_name')
                .eq('jid', cleanJid)
                .eq('company_id', companyId)
                .maybeSingle()
        );

        if (contact?.is_ignored) {
            return null; 
        }

        let finalName = null;

        // Prioridade de Nome para o Lead:
        // 1. Agenda (contacts.name) - Confiança TOTAL se existir no banco.
        
        if (contact) {
            if (contact.name && contact.name.trim().length > 0) {
                // TRUST THE DB: Se tem nome no banco, usa. Ignora isGenericName aqui.
                finalName = contact.name;
            } 
            else if (contact.verified_name && !isGenericName(contact.verified_name, purePhone)) {
                finalName = contact.verified_name;
            }
            else if (contact.push_name && !isGenericName(contact.push_name, purePhone)) {
                finalName = contact.push_name;
            }
        }
        
        // TRUST TUNNEL: Se ainda não pegamos do banco (race condition), usamos o pushName passado
        // Se trustName=true (Agenda), aceitamos mesmo que pareça genérico (ex: "102")
        if (!finalName && pushName) {
            if (trustName || !isGenericName(pushName, purePhone)) {
                finalName = pushName;
            }
        }

        const { data: existing } = await safeSupabaseCall(() => 
            supabase.from('leads').select('id, name').eq('phone', purePhone).eq('company_id', companyId).maybeSingle()
        );

        if (existing) {
            // Auto-Healing: Melhora o nome se o atual for ruim
            const currentNameIsBad = !existing.name || isGenericName(existing.name, purePhone);
            // Só atualiza se o novo nome for bom OU se for trusted (Agenda)
            const newNameIsGood = finalName && (trustName || !isGenericName(finalName, purePhone));

            if (currentNameIsBad && newNameIsGood) {
                console.log(`✨ [CRM] Melhorando nome do Lead ${purePhone}: "${existing.name || 'NULL'}" -> "${finalName}"`);
                await supabase.from('leads').update({ name: finalName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // Validação final de segurança para criação:
        // Se NÃO é trusted (Agenda) e é genérico, anula para criar como NULL (frontend formata)
        // Se É trusted, deixa passar o nome "102" ou "Mãe"
        if (finalName && !trustName && isGenericName(finalName, purePhone) && contact?.name !== finalName) {
            finalName = null;
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
        console.error("Erro ao criar lead:", e.message);
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
