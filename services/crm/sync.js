
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Mutex para evitar criação duplicada de Leads em rajadas
const leadLock = new Set(); 

// --- HELPER: NAME VALIDATION ---
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    const lower = cleanName.toLowerCase();
    if (lower === 'null' || lower === 'undefined' || lower === 'unknown') return true;
    
    // Se o nome for igual ao telefone (anti-spam)
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;

    // Deve conter letras reais
    return !/[a-zA-Z\u00C0-\u00FF]/.test(cleanName); 
};

// --- HELPER: JID NORMALIZATION ---
export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid.split('@')[0] + '@g.us';
    if (jid.includes('@lid')) return jid; // Mantém LID intacto para resolução
    return jid.split('@')[0].split(':')[0] + '@s.whatsapp.net';
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {}
};

// --- IDENTITY RESOLVER (A CURA DA DUPLICIDADE) ---
// Tenta encontrar o telefone real dado um JID (que pode ser um LID)
const resolveRealPhone = async (jid, companyId) => {
    // 1. Se já é um telefone padrão BR (DDI 55), retorna limpo
    if (jid.includes('@s.whatsapp.net') && jid.startsWith('55')) {
        return jid.split('@')[0];
    }

    // 2. Se é um LID ou número estranho, busca no mapa de identidades
    if (jid.includes('@lid') || !jid.startsWith('55')) {
        // Tenta buscar na tabela contacts se esse JID tem um vinculo
        // Nota: A tabela identity_map seria ideal, mas vamos usar contacts.phone se disponível ou fallback
        // Lógica: Busca um contato onde jid == o LID atual
        // Mas o ideal é que tenhamos salvo o link antes.
        
        // Tentativa de buscar mapeamento reverso no banco
        const { data } = await supabase.from('identity_map')
            .select('phone_jid')
            .eq('lid_jid', jid)
            .eq('company_id', companyId)
            .maybeSingle();
            
        if (data?.phone_jid) {
            return data.phone_jid.split('@')[0];
        }
    }

    // Fallback: Retorna o próprio número limpo
    return jid.split('@')[0];
};

// --- SYNC CONTACTS ---
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false, lidJid = null) => {
    try {
        if (!jid || !companyId) return;
        if (jid.includes('status@broadcast')) return;

        const cleanJid = normalizeJid(jid);
        const isGroup = cleanJid.includes('@g.us');
        
        // LÓGICA LID: Se recebermos um LID junto com o telefone, salvamos o mapeamento
        if (lidJid && !isGroup) {
            await supabase.from('identity_map').upsert({
                lid_jid: normalizeJid(lidJid),
                phone_jid: cleanJid,
                company_id: companyId
            }, { onConflict: 'lid_jid' });
        }

        const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
        
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date()
        };

        const nameIsValid = !isGenericName(incomingName, purePhone);

        if (nameIsValid) {
            updateData.push_name = incomingName;
            if (isFromBook) {
                updateData.name = incomingName; // Autoridade Máxima
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // Upsert Contato
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // LEAD SELF-HEALING
        if (!error && !isGroup) {
            // Resolve telefone real (caso tenhamos passado um LID por engano, embora upsertContact deva receber Phone JID preferencialmente)
            const realPhone = await resolveRealPhone(cleanJid, companyId);
            
            const { data: lead } = await supabase.from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', realPhone)
                .limit(1)
                .maybeSingle();

            if (lead) {
                const currentNameIsBad = !lead.name || isGenericName(lead.name, realPhone);
                if (nameIsValid && (currentNameIsBad || isFromBook)) {
                    await supabase.from('leads').update({ name: incomingName }).eq('id', lead.id);
                }
            } else if (isFromBook && nameIsValid) {
                await ensureLeadExists(cleanJid, companyId, incomingName);
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

// --- ENSURE LEAD ---
export const ensureLeadExists = async (jid, companyId, pushName) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    // RESOLUÇÃO DE IDENTIDADE CRÍTICA
    // Se jid for LID, isso retorna o telefone real. Se for telefone, retorna ele mesmo.
    const realPhone = await resolveRealPhone(normalizeJid(jid), companyId);
    
    // Se ainda parecer um LID (começa com 2, longo, não é BR), e não conseguimos resolver
    // ABORTA a criação para não criar lead duplicado/lixo.
    if (realPhone.length > 13 && !realPhone.startsWith('55')) {
        // console.warn(`[SYNC] Ignorando criação de lead para ID não resolvido: ${realPhone}`);
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

        // CRIAÇÃO DE NOVO LEAD
        // Regra: Nome NULL se for inválido
        let finalName = nameIsValid ? pushName : null;
        
        if (!finalName) {
            // Backup na tabela contacts usando o phone JID
            const { data: contact } = await supabase.from('contacts')
                .select('name, push_name')
                .eq('phone', realPhone) // Busca pelo phone column
                .eq('company_id', companyId)
                .limit(1)
                .maybeSingle();
                
            if (contact) {
                if (!isGenericName(contact.name, realPhone)) finalName = contact.name;
                else if (!isGenericName(contact.push_name, realPhone)) finalName = contact.push_name;
            }
        }

        // Pega Funil Default
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
        // Delay para garantir que Identity Map e Lead já existam
        await new Promise(resolve => setTimeout(resolve, 300));
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        
        // Se a mensagem vier de um LID, tentamos salvar também o mapeamento se possível,
        // mas aqui focamos em salvar a mensagem
        
        const finalData = {
            ...msgData,
            remote_jid: cleanRemoteJid
        };

        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
    } catch (e) {}
};

// Funções utilitárias
export const savePollVote = async (msg, companyId) => {};
export const deleteSessionData = async (sessionId) => {
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};
export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
