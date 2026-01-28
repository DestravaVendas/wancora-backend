
import { createClient } from "@supabase/supabase-js";
import { normalizeJid } from '../utils/wppParsers.js'; // Uso do parser centralizado
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Mutex para evitar Race Conditions na criação de leads
const leadLock = new Set(); 

// --- HELPERS ---

const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    // Se o nome for igual ao telefone (ex: "+55...")
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;
    // Deve conter letras para ser válido
    return !/[a-zA-Z\u00C0-\u00FF]/.test(cleanName);
};

const formatPhoneAsName = (phone) => {
    if (!phone) return "Desconhecido";
    const p = phone.replace(/\D/g, '');
    if (p.length >= 12 && p.startsWith('55')) {
        const ddd = p.substring(2, 4);
        const num = p.substring(4);
        return `+55 (${ddd}) ${num.substring(0, 5)}-${num.substring(5)}`;
    }
    return `+${p}`;
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
        
        // 1. Atualiza Tabela de Contatos
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date()
        };

        const nameIsValid = !isGenericName(incomingName, purePhone);

        if (nameIsValid) {
            updateData.push_name = incomingName;
            // Se veio da Agenda do celular, sobrescreve o nome principal
            if (isFromBook) {
                updateData.name = incomingName;
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });
        if (error) throw error;

        // 2. Mapeamento de LID (Se disponível)
        if (lid) {
            const cleanLid = normalizeJid(lid);
            // Chama RPC para vincular sem travar
            supabase.rpc('link_identities', { 
                p_lid: cleanLid, 
                p_phone: cleanJid, 
                p_company_id: companyId 
            }).then(() => {});
        }

        // 3. Lead Self-Healing (Cura de Nomes Genéricos)
        if (!cleanJid.includes('@g.us') && nameIsValid) {
            const { data: lead } = await supabase.from('leads').select('id, name').eq('company_id', companyId).eq('phone', purePhone).limit(1).maybeSingle();
            
            if (lead) {
                // Se o lead tem nome feio e achamos um bonito, atualiza
                if (isGenericName(lead.name, purePhone) || isFromBook) {
                    await supabase.from('leads').update({ name: incomingName }).eq('id', lead.id);
                }
            } else if (isFromBook) {
                // Se veio da agenda e não é lead, cria (Opcional, depende da regra de negócio. Aqui mantemos conservador)
                // await ensureLeadExists(cleanJid, companyId, incomingName);
            }
        }

    } catch (e) {
        console.error(`❌ [SYNC] Erro upsertContact:`, e.message);
    }
};

export const ensureLeadExists = async (jid, companyId, pushName, myJid) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 
    
    // Não cria lead para mim mesmo
    if (myJid && normalizeJid(jid) === normalizeJid(myJid)) return null;

    const cleanJid = normalizeJid(jid);
    const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
    
    if (purePhone.length < 8) return null;
    
    // Mutex Local para evitar Race Condition na mesma instância
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
            // Self-Healing se o nome melhorou
            if (nameIsValid && isGenericName(existing.name, purePhone)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 2. Tenta recuperar nome da tabela Contacts se o pushName for ruim
        let finalName = nameIsValid ? pushName : formatPhoneAsName(purePhone);
        
        if (isGenericName(finalName, purePhone)) {
            const { data: contact } = await supabase.from('contacts').select('name, push_name').eq('jid', cleanJid).eq('company_id', companyId).maybeSingle();
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

        // 4. Criação
        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: purePhone,
            name: finalName, 
            status: 'new',
            pipeline_stage_id: stage?.id,
            position: Date.now() // Timestamp para ordenação
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
        // Pequeno delay para garantir que Lead/Contato existam (Integridade Referencial)
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        
        const finalData = {
            ...msgData,
            remote_jid: cleanRemoteJid
        };

        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
        
    } catch (e) {
        console.error(`❌ [SYNC] Erro upsertMessage:`, e.message);
    }
};

export const updateCampaignStats = async (campaignId, status) => {
    try {
        // Usa RPC atômica para contar envio/falha
        await supabase.rpc('increment_campaign_count', { 
            p_campaign_id: campaignId, 
            p_field: status 
        });
    } catch (e) {
        // console.error(`[SYNC] Campaign stats error:`, e.message);
    }
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

// Export para compatibilidade
export { normalizeJid };
