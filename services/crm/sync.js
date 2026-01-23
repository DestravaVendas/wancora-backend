
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

const leadLock = new Set(); 

const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    const lower = cleanName.toLowerCase();
    if (lower === 'null' || lower === 'undefined' || lower === 'unknown') return true;
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;
    return !/[a-zA-Z\u00C0-\u00FF]/.test(cleanName); 
};

export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid.split('@')[0] + '@g.us';
    if (jid.includes('@lid')) return jid; 
    return jid.split('@')[0].split(':')[0] + '@s.whatsapp.net';
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        // Envia sem await para não bloquear o loop (Fire & Forget)
        supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId)
            .then(() => {}); 
    } catch (e) {}
};

// --- IDENTITY RESOLVER 2.0 ---
// Busca o telefone real (JID legado) dado um LID ou JID
const resolveRealPhone = async (jid, companyId) => {
    if (!jid) return null;
    
    // 1. Se já é telefone padrão, retorna limpo
    if (jid.includes('@s.whatsapp.net') && !jid.includes('@lid')) {
        return jid.split('@')[0];
    }

    // 2. Se for LID, busca no identity_map
    if (jid.includes('@lid')) {
        const { data } = await supabase.from('identity_map')
            .select('phone_jid')
            .eq('lid_jid', jid)
            .eq('company_id', companyId)
            .maybeSingle();
            
        if (data?.phone_jid) {
            return data.phone_jid.split('@')[0];
        }
    }

    // Fallback: Se não achou mapeamento, retorna o próprio ID mas limpo
    // Isso evita crash, mas o ideal é ter o mapeamento.
    return jid.split('@')[0];
};

export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false, lidJid = null) => {
    try {
        if (!jid || !companyId) return;
        if (jid.includes('status@broadcast')) return;

        const cleanJid = normalizeJid(jid);
        const isGroup = cleanJid.includes('@g.us');
        
        // --- 1. SALVAR MAPEAMENTO DE IDENTIDADE ---
        // Se recebemos um par LID + Phone, salvamos imediatamente
        if (lidJid && !isGroup) {
            await supabase.from('identity_map').upsert({
                lid_jid: normalizeJid(lidJid),
                phone_jid: cleanJid, // Assume que cleanJid aqui é o phone (vinda do listener)
                company_id: companyId
            }, { onConflict: 'lid_jid' });
        }

        // --- 2. DEFINIR COLUNA PHONE CORRETA ---
        let phoneColumnValue = cleanJid.split('@')[0].replace(/\D/g, '');
        
        // Se o JID principal for LID, precisamos achar o telefone real para a coluna 'phone'
        // senão a coluna fica com "123123123..." (ID interno do whatsapp)
        if (cleanJid.includes('@lid')) {
            const realPhone = await resolveRealPhone(cleanJid, companyId);
            if (realPhone && !realPhone.includes('@lid')) {
                phoneColumnValue = realPhone.replace(/\D/g, '');
            }
        }

        const updateData = {
            jid: cleanJid,
            phone: phoneColumnValue, // Agora contém o número real legível
            company_id: companyId,
            updated_at: new Date()
        };

        const nameIsValid = !isGenericName(incomingName, phoneColumnValue);

        if (nameIsValid) {
            updateData.push_name = incomingName;
            if (isFromBook) {
                updateData.name = incomingName;
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // Upsert Contato
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // --- 3. LEAD SELF-HEALING ---
        if (!error && !isGroup) {
            // Resolvemos novamente para garantir consistência ao buscar o Lead
            const realPhoneJid = await resolveRealPhone(cleanJid, companyId);
            const realPhoneNum = realPhoneJid ? realPhoneJid.replace(/\D/g, '') : phoneColumnValue;

            // Só processa lead se tivermos um número de telefone válido (não LID)
            if (realPhoneNum.length < 15) { // LIDs costumam ser maiores, telefones < 15
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
                    // Se veio da agenda, cria o lead imediatamente
                    await ensureLeadExists(cleanJid, companyId, incomingName);
                }
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

export const ensureLeadExists = async (jid, companyId, pushName, myBotJid = null) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    const cleanJid = normalizeJid(jid);
    
    // --- PROTEÇÃO ANTI SELF-LEAD (CRÍTICO) ---
    // Se o remetente for eu mesmo (Bot), não cria Lead.
    if (myBotJid) {
        const cleanBot = normalizeJid(myBotJid);
        // Compara JIDs diretos
        if (cleanJid === cleanBot) return null;
        
        // Compara telefones (caso um seja LID e outro Phone)
        const phoneA = await resolveRealPhone(cleanJid, companyId);
        const phoneB = await resolveRealPhone(cleanBot, companyId);
        if (phoneA && phoneB && phoneA === phoneB) return null;
    }

    const realPhone = await resolveRealPhone(cleanJid, companyId);
    
    // Se ainda for LID ou inválido, aborta.
    // Telefones BR começam com 55 e tem < 14 digitos. LIDs tem > 15.
    if (!realPhone || (realPhone.length > 14 && !realPhone.startsWith('55'))) {
        return null;
    }

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

        // Backup: Busca nome na tabela contacts se o pushName for ruim
        let finalName = nameIsValid ? pushName : null;
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

export const upsertMessage = async (msgData) => {
    try {
        // Delay tático reduzido
        await new Promise(resolve => setTimeout(resolve, 50)); 
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        
        const finalData = {
            ...msgData,
            remote_jid: cleanRemoteJid
        };

        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
    } catch (e) {}
};

export const savePollVote = async (msg, companyId) => {};
export const deleteSessionData = async (sessionId) => {
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};
export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
