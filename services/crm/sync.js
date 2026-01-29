
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
    
    // Se o nome contém apenas números e símbolos
    if (/^[\d\s\+\-\(\)]+$/.test(cleanName)) return true;

    // Se o nome for igual ao telefone
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;
    
    // Deve conter pelo menos uma letra
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

/**
 * UPSERT CONTACT MASTER (Missão 3)
 * @param {string} jid - ID do usuário
 * @param {string} companyId - ID da empresa
 * @param {string} incomingName - Nome vindo do evento (Notify ou Agenda)
 * @param {string} profilePicUrl - URL da foto (se houver atualização)
 * @param {boolean} isFromBook - Se true, força a atualização do nome (Autoridade Máxima)
 * @param {string} lid - Identificador oculto (LID) para vínculo
 */
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

        // 1. Busca Contato Existente para decidir Hierarquia
        const { data: existingContact } = await supabase.from('contacts')
            .select('name, push_name')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        // 2. Lógica de Hierarquia de Nomes (Name Hunter)
        if (isFromBook) {
            // Cenário A: Agenda do Dispositivo (Alta Prioridade)
            // Se veio da agenda, confiamos cegamente (exceto se for o próprio número)
            if (incomingNameValid) {
                updateData.name = incomingName;
            }
        } else {
            // Cenário B: PushName / NotifyName (Perfil Público)
            if (incomingNameValid) {
                updateData.push_name = incomingName;
                
                // Só promove pushName para 'name' se o contato não existir ou se o nome atual for NULL/Genérico
                if (!existingContact || !existingContact.name || isGenericName(existingContact.name, purePhone)) {
                    updateData.name = incomingName;
                }
                // Se já existe um nome válido (editado manualmente), NÃO tocamos nele.
            }
        }

        // 3. Atualização de Foto (Cache Control)
        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
            updateData.profile_pic_updated_at = new Date(); // Marca o timestamp para o Lazy Load
        }

        // Executa Upsert
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });
        if (error) throw error;

        // 4. Mapeamento de LID (Identity Unification)
        if (lid) {
            const cleanLid = normalizeJid(lid);
            // RPC para vincular LID ao Telefone sem bloquear o processo
            supabase.rpc('link_identities', { 
                p_lid: cleanLid, 
                p_phone: cleanJid, 
                p_company_id: companyId 
            }).then(() => {});
        }

        // 5. Lead Self-Healing (Propaga nome para o Lead se necessário)
        if (!isGroup) {
            const { data: lead } = await supabase.from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone)
                .limit(1)
                .maybeSingle();
            
            if (lead) {
                // Se o lead tem nome Ruim e recebemos um Bom, atualiza
                const leadNameBad = !lead.name || isGenericName(lead.name, purePhone);
                
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
            if (nameIsValid && (!existing.name || isGenericName(existing.name, purePhone))) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 2. Determinação do Nome
        let finalName = null;
        
        // Tenta buscar no contato primeiro
        const { data: contact } = await supabase.from('contacts')
            .select('name, push_name')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        if (contact) {
            if (!isGenericName(contact.name, purePhone)) finalName = contact.name; 
            else if (!isGenericName(contact.push_name, purePhone)) finalName = contact.push_name; 
        }

        if (!finalName && nameIsValid) finalName = pushName;

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
        await new Promise(resolve => setTimeout(resolve, 100)); // Delay para integridade
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        
        const finalData = {
            ...msgData,
            remote_jid: cleanRemoteJid
        };

        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
        
        // Trigger handle_new_message_stats no banco cuida do resto
        
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
