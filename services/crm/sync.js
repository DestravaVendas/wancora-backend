
import { createClient } from "@supabase/supabase-js";
import { normalizeJid } from '../../utils/wppParsers.js'; 
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const leadLock = new Set(); 

// --- HELPERS ---

// Valida se o nome é genérico (número de telefone, vazio ou inválido)
// Regra Estrita: Deve conter letras.
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    
    // Se o nome contém apenas números e símbolos
    if (/^[\d\s\+\-\(\)]+$/.test(cleanName)) return true;

    // Se o nome for igual ao telefone (mesmo com formatação diferente)
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;
    
    // Deve conter letras (A-Z) para ser considerado válido
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
        
        // Objeto Base
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date()
        };

        const incomingNameValid = !isGenericName(incomingName, purePhone);

        // LÓGICA DE NOME (Name Hunter V5)
        // 1. Busca contato existente para decisão
        const { data: existingContact } = await supabase.from('contacts')
            .select('name, push_name')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        if (isFromBook) {
            // Se veio da Agenda, TEM autoridade.
            // Se o nome for válido, salva. Se for inválido (número), salva NULL.
            updateData.name = incomingNameValid ? incomingName : null;
        } else {
            // Se veio do WhatsApp (PushName)
            if (incomingNameValid) {
                updateData.push_name = incomingName;
                
                // Só promove para 'name' se não existir nada válido lá
                if (!existingContact || !existingContact.name || isGenericName(existingContact.name, purePhone)) {
                    // Mas cuidado: não sobrescreva se for apenas um update de presença
                    // Opcional: updateData.name = incomingName; 
                    // Melhor deixar 'name' como NULL se não for da agenda, o frontend usa push_name como fallback.
                }
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });
        if (error) throw error;

        // 2. Mapeamento de LID
        if (lid) {
            const cleanLid = normalizeJid(lid);
            supabase.rpc('link_identities', { 
                p_lid: cleanLid, 
                p_phone: cleanJid, 
                p_company_id: companyId 
            }).then(() => {});
        }

        // 3. Lead Self-Healing (Propaga nome para o Lead se necessário)
        if (!cleanJid.includes('@g.us')) {
            const { data: lead } = await supabase.from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone)
                .limit(1)
                .maybeSingle();
            
            if (lead) {
                // Se o lead tem nome genérico/nulo e agora temos um nome válido
                const leadNameBad = isGenericName(lead.name, purePhone);
                if (leadNameBad && incomingNameValid) {
                    // Atualiza o lead com o novo nome válido
                    await supabase.from('leads').update({ name: incomingName }).eq('id', lead.id);
                }
            }
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
            // Self-Healing
            if (nameIsValid && isGenericName(existing.name, purePhone)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 2. Determinação do Nome (Hierarquia)
        // Padrão: NULL (Regra do Usuário)
        let finalName = null;
        
        const { data: contact } = await supabase.from('contacts')
            .select('name, push_name')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        if (contact) {
            if (!isGenericName(contact.name, purePhone)) finalName = contact.name; // Agenda
            else if (!isGenericName(contact.push_name, purePhone)) finalName = contact.push_name; // PushName
        }

        if (!finalName && nameIsValid) {
            finalName = pushName;
        }

        // 3. Pega Funil Padrão
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        // 4. Criação
        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: purePhone,
            name: finalName, // Pode ser NULL
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
        
        const finalData = {
            ...msgData,
            remote_jid: cleanRemoteJid
        };

        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
        
        // Atualiza last_message_at para subir o chat
        await supabase.from('contacts').update({ 
            last_message_at: msgData.created_at 
        }).eq('jid', cleanRemoteJid).eq('company_id', msgData.company_id);
        
    } catch (e) {
        console.error(`❌ [SYNC] Erro upsertMessage:`, e.message);
    }
};

export const updateCampaignStats = async (campaignId, status) => {
    try {
        await supabase.rpc('increment_campaign_count', { 
            p_campaign_id: campaignId, 
            p_field: status 
        });
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

export { normalizeJid };
