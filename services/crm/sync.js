
import { createClient } from "@supabase/supabase-js";
import { normalizeJid } from "../../utils/wppParsers.js";
import { Logger } from "../../utils/logger.js"; 
import getRedisClient from "../redisClient.js"; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false },
    db: { schema: 'public' },
    global: { headers: { 'x-my-custom-header': 'wancora-backend' } }
});

const leadLock = new Set(); 

// 🛡️ LOCK DE LEADS (ANTI-DUPLICIDADE)
const isLeadLocked = async (companyId, phone) => {
    const redis = getRedisClient();
    const lockKey = `lead_lock:${companyId}:${phone}`;
    
    if (redis && redis.status === 'ready') {
        const exists = await redis.get(lockKey);
        if (exists) return true;
        await redis.set(lockKey, '1', 'EX', 5); // Lock de 5 segundos
        return false;
    } else {
        // Fallback em memória
        if (leadLock.has(lockKey)) return true;
        leadLock.add(lockKey);
        setTimeout(() => leadLock.delete(lockKey), 5000);
        return false;
    }
};

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
    if (cleanName.length < 2) return true; 
    if (/^[\d\s\+\-\(\)]*$/.test(cleanName)) return true; 
    
    // Se o nome contém "@lid" ou é apenas um número longo (LID), é técnico
    if (cleanName.includes('@lid')) return true;
    if (cleanName.length > 13 && /^\d+$/.test(cleanName)) return true;

    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true; 
    return !/[a-zA-Z\u00C0-\u00FF]/.test(cleanName); 
};

/**
 * 🛡️ [NORMALIZER SERVICE] Resolve JID LID para JID de Telefone usando o mapa de identidade
 * Detecta também IDs técnicos (LIDs) mascarados como números de telefone.
 */
export const resolveJid = async (jid, companyId) => {
    if (!jid) return null;
    
    let cleanJid = normalizeJid(jid);
    const pureId = cleanJid.split('@')[0];
    
    // 🛡️ [DETECÇÃO AVANÇADA] 
    // Se o ID for muito longo (> 13 dígitos) ou contiver @lid, é um identificador técnico
    const isTechnicalId = cleanJid.includes('@lid') || (pureId.length > 13 && /^\d+$/.test(pureId));
    
    if (!isTechnicalId) return cleanJid;

    try {
        // 1. Busca no Mapa de Identidade (Hard Resolution)
        const { data } = await supabase
            .from('identity_map')
            .select('phone_jid')
            .eq('lid_jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        if (data?.phone_jid) return normalizeJid(data.phone_jid);

        // 2. Se for um LID mascarado em @s.whatsapp.net, tenta buscar o inverso no mapa
        if (cleanJid.includes('@s.whatsapp.net')) {
             const lidEquivalent = cleanJid.replace('@s.whatsapp.net', '@lid');
             const { data: inverseMap } = await supabase
                .from('identity_map')
                .select('phone_jid')
                .eq('lid_jid', lidEquivalent)
                .eq('company_id', companyId)
                .maybeSingle();
             if (inverseMap?.phone_jid) return normalizeJid(inverseMap.phone_jid);
        }

        // 3. Soft Resolution (Heurística baseada em contatos existentes)
        const purePhone = pureId.replace(/\D/g, '');
        if (purePhone.length >= 10 && !purePhone.startsWith('0')) {
            const phoneJid = `${purePhone}@s.whatsapp.net`;
            // Linka preventivamente se o número parecer válido
            supabase.rpc('link_identities', { p_lid: cleanJid, p_phone: phoneJid, p_company_id: companyId }).then(() => {});
            return phoneJid;
        }

        return cleanJid;
    } catch (e) {
        return cleanJid;
    }
};

export const notifyActivity = (companyId, sessionId, type) => {
    // 🛡️ [BROADCAST] Notifica o frontend via Realtime para manter o indicador de sync ativo
    // Usamos o sessionId como canal, o frontend se inscreve nele.
    supabase.channel(`sync-activity-${sessionId}`).send({
        type: 'broadcast',
        event: 'activity',
        payload: { type, timestamp: Date.now() }
    }).catch(() => {});
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
    
    const validContacts = [];
    for (const c of contactsArray) {
        if (!c.jid || !c.company_id) continue;
        
        let cleanJid = normalizeJid(c.jid);
        // Tenta resolver LID se for o caso
        if (cleanJid.includes('@lid')) {
            const resolved = await resolveJid(cleanJid, c.company_id);
            if (resolved && !resolved.includes('@lid')) {
                cleanJid = resolved;
            }
        }

        const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
        const contactData = { ...c, jid: cleanJid, phone: purePhone };
        
        // 🛡️ [FIX] Remove undefined values
        Object.keys(contactData).forEach(key => contactData[key] === undefined && delete contactData[key]);
        
        validContacts.push(contactData);
    }

    if (validContacts.length === 0) return;

    // Notifica atividade para o indicador visual
    if (validContacts[0].session_id) {
        notifyActivity(validContacts[0].company_id, validContacts[0].session_id, 'bulk_contacts');
    }

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

        // 🛡️ [FIX] Resolve LID antes de salvar
        let cleanJid = normalizeJid(jid);
        if (cleanJid.includes('@lid')) {
            const resolved = await resolveJid(cleanJid, companyId);
            if (resolved && !resolved.includes('@lid')) {
                cleanJid = resolved;
            }
        }

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

        // 🛡️ [FIX] Remove undefined values to prevent Supabase client issues (fetch failed)
        Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

        if (extraData.session_id) {
            notifyActivity(companyId, extraData.session_id, 'contact_upsert');
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
    
    // 🛡️ [FIX] Resolve LID antes de qualquer operação de Lead
    let cleanJid = normalizeJid(jid);
    if (!cleanJid) return null;

    if (cleanJid.includes('@lid')) {
        const resolved = await resolveJid(cleanJid, companyId);
        if (resolved && !resolved.includes('@lid')) {
            cleanJid = resolved;
        } else {
            // Se não conseguimos resolver o LID para um telefone real, 
            // NÃO criamos o lead ainda para evitar duplicidade.
            // O sistema aguardará o mapeamento de identidade do Baileys.
            console.log(`⚠️ [SYNC] Ignorando criação de lead para LID não resolvido: ${cleanJid}`);
            return null;
        }
    }

    if (cleanJid.includes('@g.us') || cleanJid.includes('@newsletter') || cleanJid.includes('status@broadcast')) return null; 
    
    if (myJid) {
        const cleanMyJid = normalizeJid(myJid);
        if (cleanMyJid && cleanJid === cleanMyJid) return null;
    }

    const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
    if (purePhone.length < 8 || purePhone.length > 15) return null;
    
    // 🛡️ LOCK: Evita que duas mensagens do mesmo lead criem dois registros no Supabase
    const locked = await isLeadLocked(companyId, purePhone);
    if (locked) return null;
    
    try {
        const { data: contact } = await safeSupabaseCall(() => 
            supabase.from('contacts').select('is_ignored, name, push_name, verified_name').eq('jid', cleanJid).eq('company_id', companyId).maybeSingle()
        );

        if (contact?.is_ignored) return null; 

        // LÓGICA DE NOME: Prioridade Agenda > Verified > Push > Novo Push
        let finalName = null;
        if (contact) {
            if (contact.name && !isGenericName(contact.name, purePhone)) finalName = contact.name; 
            else if (contact.verified_name && !isGenericName(contact.verified_name, purePhone)) finalName = contact.verified_name;
            else if (contact.push_name && !isGenericName(contact.push_name, purePhone)) finalName = contact.push_name;
        }
        
        // Auto-Healing: Se o nome atual é ruim e temos um pushName novo bom, usa ele
        if ((!finalName || isGenericName(finalName, purePhone)) && pushName && !isGenericName(pushName, purePhone)) {
            finalName = pushName;
            // Persiste o novo nome descoberto no contato apenas se for realmente melhor
            await supabase.from('contacts').update({ push_name: pushName, updated_at: new Date() }).eq('jid', cleanJid).eq('company_id', companyId);
        }

        const { data: existing } = await safeSupabaseCall(() => 
            supabase.from('leads').select('id, name').eq('phone', purePhone).eq('company_id', companyId).limit(1).maybeSingle()
        );

        if (existing) {
            // Auto-Healing Lead: Atualiza lead se o nome dele for genérico e agora temos um bom
            const currentNameIsBad = !existing.name || isGenericName(existing.name, purePhone);
            const newNameIsGood = finalName && !isGenericName(finalName, purePhone);

            if (currentNameIsBad && newNameIsGood) {
                await supabase.from('leads').update({ name: finalName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // Se ainda for nulo ou genérico, manda NULL (Frontend formata)
        if (finalName && isGenericName(finalName, purePhone)) {
            finalName = null;
        }

        const { data: stage } = await supabase.from('pipeline_stages').select('id').eq('company_id', companyId).order('position', { ascending: true }).limit(1).maybeSingle();

        const leadPayload = {
            company_id: companyId,
            phone: purePhone,
            name: finalName, 
            status: 'new',
            pipeline_stage_id: stage?.id || null,
            position: Date.now()
        };

        // 🛡️ [FIX] Remove undefined values
        Object.keys(leadPayload).forEach(key => leadPayload[key] === undefined && delete leadPayload[key]);

        const { data: newLead } = await safeSupabaseCall(() => 
            supabase.from('leads').insert(leadPayload).select('id').single()
        );

        return newLead?.id;

    } catch (e) {
        Logger.error('baileys', `Erro ao criar lead ${purePhone}`, { error: e.message }, companyId);
        return null;
    }
};

export const upsertMessage = async (msgData) => {
    try {
        if (msgData.remote_jid.includes('status@broadcast')) return;
        
        // 🛡️ [NORMALIZER] Arquitetura de Unificação Retroativa
        let originalJid = normalizeJid(msgData.remote_jid);
        const pureId = originalJid.split('@')[0];
        
        // Detecta se é um ID técnico (LID)
        const isTechnical = originalJid.includes('@lid') || (pureId.length > 13 && /^\d+$/.test(pureId));
        let lidJid = isTechnical ? originalJid : null;
        let canonicalJid = originalJid;
        
        // Tenta resolver o JID real se for um identificador técnico
        if (isTechnical) {
            const resolved = await resolveJid(originalJid, msgData.company_id);
            if (resolved && resolved !== originalJid) {
                console.log(`🔗 [SYNC] Unificando ID Técnico ${originalJid} -> ${resolved}`);
                canonicalJid = resolved;
            }
        }

        const purePhone = canonicalJid.includes('@s.whatsapp.net') 
            ? canonicalJid.split('@')[0].replace(/\D/g, '') 
            : null;

        // 🛡️ [FIX] Se o "telefone" ainda for um LID mascarado (longo), não salva na coluna phone
        const finalPhone = (purePhone && purePhone.length <= 13) ? purePhone : null;

        const finalData = { 
            ...msgData, 
            remote_jid: originalJid,     // Mantém o ID original do Baileys para integridade
            lid_jid: lidJid,             // Armazena o LID para o Trigger de unificação retroativa
            canonical_jid: canonicalJid, // O ID unificado (Telefone se soubermos)
            phone: finalPhone            // Apenas números reais para busca e CRM
        };

        // 🛡️ [FIX] Remove undefined values to prevent Supabase client issues (fetch failed)
        Object.keys(finalData).forEach(key => finalData[key] === undefined && delete finalData[key]);

        notifyActivity(msgData.company_id, msgData.session_id, 'message_upsert');

        await safeSupabaseCall(async () => {
            // 🛡️ [DEBUG] Log para rastrear mensagens fromMe que não aparecem
            if (msgData.from_me) {
                console.log(`💾 [SYNC] Salvando mensagem fromMe: ${msgData.whatsapp_id} para ${canonicalJid}`);
            }

            // 1. Upsert da Mensagem (Agora usando a restrição unificada por whatsapp_id)
            const { error: msgError } = await supabase.from('messages').upsert(finalData, { onConflict: 'company_id, whatsapp_id' });
            if (msgError) {
                console.error(`❌ [SYNC] Erro Supabase ao salvar mensagem (${msgData.whatsapp_id}):`, msgError.message, {
                    code: msgError.code,
                    details: msgError.details,
                    hint: msgError.hint
                });
                throw msgError;
            }

            // 2. [GARANTIA] Upsert do Contato (Sempre usando o JID Canônico para evitar duplicidade na Inbox)
            const { error: contactError } = await supabase.from('contacts').upsert({
                jid: canonicalJid,
                company_id: msgData.company_id,
                phone: purePhone,
                last_message_at: msgData.created_at || new Date()
            }, { onConflict: 'jid, company_id' });

            if (contactError) {
                console.error(`❌ [SYNC] Erro Supabase ao atualizar contato:`, contactError.message);
            }
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
