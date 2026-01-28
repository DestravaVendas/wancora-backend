
import { createClient } from "@supabase/supabase-js";
import { normalizeJid } from '../../utils/wppParsers.js'; 
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const leadLock = new Set(); 

// --- HELPERS ---

// Valida se o nome é genérico (número de telefone, vazio ou inválido)
// REGRA DO NULL: Deve conter letras para ser considerado um nome real.
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    
    // Se o nome contém apenas números e símbolos
    if (/^[\d\s\+\-\(\)]+$/.test(cleanName)) return true;

    // Se o nome for igual ao telefone (mesmo com formatação diferente)
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;
    
    // Deve conter pelo menos uma letra (A-Z) para ser considerado válido
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
        const isGroup = cleanJid.includes('@g.us');
        
        // Objeto Base
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date()
        };

        const incomingNameValid = !isGenericName(incomingName, purePhone);

        // LÓGICA DE NOME (Name Hunter V6 - Strict NULL)
        const { data: existingContact } = await supabase.from('contacts')
            .select('name, push_name')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        if (isFromBook) {
            // Cenário: Agenda do Dispositivo (Alta Prioridade)
            // Se o nome da agenda for válido, usamos. Se for o número, forçamos NULL.
            updateData.name = incomingNameValid ? incomingName : null;
        } else {
            // Cenário: PushName / NotifyName
            if (incomingNameValid) {
                updateData.push_name = incomingName;
                
                // Cenário 1: Enriquecimento Tardio
                // Se não existe, ou se o nome atual é NULL, aceitamos o PushName como nome principal
                if (!existingContact || existingContact.name === null || existingContact.name === '') {
                    updateData.name = incomingName;
                }
                // Cenário 2: Proteção de Edição
                // Se já existe um nome válido (provavelmente editado manualmente ou da agenda), 
                // IGNORAMOS o incomingName no campo 'name', salvando apenas em 'push_name'.
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });
        if (error) throw error;

        // 2. Mapeamento de LID (Identity Unification)
        if (lid) {
            const cleanLid = normalizeJid(lid);
            supabase.rpc('link_identities', { 
                p_lid: cleanLid, 
                p_phone: cleanJid, 
                p_company_id: companyId 
            }).then(() => {});
        }

        // 3. Lead Self-Healing (Propaga nome para o Lead se necessário)
        // Só propaga se não for grupo e se tivermos um nome válido agora
        if (!isGroup) {
            const { data: lead } = await supabase.from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone)
                .limit(1)
                .maybeSingle();
            
            if (lead) {
                const leadNameBad = isGenericName(lead.name, purePhone);
                // Se o lead tem nome ruim e achamos um nome bom (ou veio da agenda), atualiza
                if (leadNameBad && incomingNameValid) {
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
    if (myJid && normalizeJid(jid) === normalizeJid(myJid)) return null; // Self-exclusion

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
            // Self-Healing: Atualiza nome do lead se ele era genérico e agora temos um bom
            if (nameIsValid && isGenericName(existing.name, purePhone)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 2. Determinação do Nome (Hierarquia)
        // Padrão: NULL (Regra do NULL)
        let finalName = null;
        
        const { data: contact } = await supabase.from('contacts')
            .select('name, push_name')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        if (contact) {
            if (!isGenericName(contact.name, purePhone)) finalName = contact.name; 
            else if (!isGenericName(contact.push_name, purePhone)) finalName = contact.push_name; 
        }

        if (!finalName && nameIsValid) {
            finalName = pushName;
        }
        
        // AUTO-LEAD: Se ainda não tem nome, usa o número formatado como fallback para garantir a criação
        if (!finalName) {
            finalName = `+${purePhone}`;
        }

        // 3. Pega Funil Padrão
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        // 4. Criação
        console.log(`⚡ [AUTO-LEAD] Criando lead para ${purePhone}`);
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
        // Delay tático para garantir que Contact/Lead existam (FK implícita)
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        
        const finalData = {
            ...msgData,
            remote_jid: cleanRemoteJid
        };

        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
        
        // Atualiza last_message_at no contato para subir o chat na lista
        // Usa Upsert para garantir que o contato exista mesmo se for a primeira mensagem
        await supabase.from('contacts').upsert({
            jid: cleanRemoteJid,
            company_id: msgData.company_id,
            last_message_at: msgData.created_at,
            phone: cleanRemoteJid.split('@')[0].replace(/\D/g, '')
        }, { onConflict: 'company_id, jid', ignoreDuplicates: false });
        
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
