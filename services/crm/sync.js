
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Service Role Key é obrigatória aqui para ignorar RLS e garantir escrita
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'info' }); // Nível Info para ver operações críticas

const leadLock = new Set(); 

// --- HELPER: NAME VALIDATION (Name Hunter V5) ---
// Função crítica para evitar que leads fiquem com nomes como "+551199..." ou "Null"
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    const lower = cleanName.toLowerCase();
    
    // Lista negra de nomes genéricos
    if (lower === 'null' || lower === 'undefined' || lower === 'unknown' || lower === 'usuario' || lower === 'contato') return true;
    
    // Se o nome for igual ao telefone (com ou sem formatação)
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;

    // Deve conter pelo menos uma letra para ser considerado nome válido
    const hasLetters = /[a-zA-Z\u00C0-\u00FF]/.test(cleanName);
    return !hasLetters; 
};

// --- HELPER: JID NORMALIZATION ---
export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid.split('@')[0] + '@g.us';
    if (jid.includes('@lid')) return jid; // Mantém LID para o mapa de identidade
    return jid.split('@')[0].split(':')[0] + '@s.whatsapp.net';
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        // Atualiza status da instância para feedback visual no frontend
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {
        console.error(`❌ [SYNC] Erro ao atualizar status:`, e.message);
    }
};

// Resolve ID real (Phone JID) a partir de um LID ou JID sujo
const resolveRealPhone = async (jid, companyId) => {
    if (!jid) return null;
    
    // Se já é formato padrão, retorna limpo
    if (jid.includes('@s.whatsapp.net') && !jid.includes('@lid')) {
        return jid.split('@')[0];
    }
    
    // Se é LID, busca no mapa de identidade
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
    return jid.split('@')[0];
};

// --- CORE: UPSERT CONTACT (Com lógica de LID) ---
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false, lidJid = null) => {
    try {
        if (!jid || !companyId) return;
        if (jid.includes('status@broadcast')) return;

        const cleanJid = normalizeJid(jid);
        const isGroup = cleanJid.includes('@g.us');
        
        // 1. Identity Resolution: Mapeia LID -> Phone JID
        if (lidJid && !isGroup) {
            await supabase.from('identity_map').upsert({
                lid_jid: normalizeJid(lidJid),
                phone_jid: cleanJid, 
                company_id: companyId
            }, { onConflict: 'lid_jid' });
        }

        // Define o telefone para salvar na coluna 'phone'
        let phoneColumnValue = cleanJid.split('@')[0].replace(/\D/g, '');
        if (cleanJid.includes('@lid')) {
            const realPhone = await resolveRealPhone(cleanJid, companyId);
            if (realPhone && !realPhone.includes('@lid')) {
                phoneColumnValue = realPhone.replace(/\D/g, '');
            }
        }

        // 2. Validação de Nome (Name Hunter)
        const nameIsValid = !isGenericName(incomingName, phoneColumnValue);
        
        const updateData = {
            jid: cleanJid,
            phone: phoneColumnValue,
            company_id: companyId,
            updated_at: new Date()
        };

        if (nameIsValid) {
            updateData.push_name = incomingName;
            // Se veio da agenda (isFromBook), tem autoridade máxima
            if (isFromBook) {
                updateData.name = incomingName;
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // Se não temos nome válido, fazemos um upsert "light" para não apagar dados existentes
        if (!nameIsValid && !profilePicUrl) {
             delete updateData.name;
             delete updateData.push_name;
             delete updateData.profile_pic_url;
        }

        // 3. Upsert Tabela Contacts
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // 4. Propagação para Leads (Self-Healing)
        if (!error && !isGroup) {
            const realPhoneJid = await resolveRealPhone(cleanJid, companyId);
            const realPhoneNum = realPhoneJid ? realPhoneJid.replace(/\D/g, '') : phoneColumnValue;

            if (realPhoneNum.length < 15) { 
                const { data: lead } = await supabase.from('leads')
                    .select('id, name')
                    .eq('company_id', companyId)
                    .eq('phone', realPhoneNum)
                    .limit(1)
                    .maybeSingle();

                if (lead) {
                    const currentNameIsBad = !lead.name || isGenericName(lead.name, realPhoneNum);
                    // Só atualiza o lead se o nome novo for BOM e o atual for RUIM (ou se for da agenda)
                    if (nameIsValid && (currentNameIsBad || isFromBook)) {
                        await supabase.from('leads').update({ name: incomingName }).eq('id', lead.id);
                    }
                } else if (isFromBook && nameIsValid) {
                    // Se veio da agenda e não é lead, cria automaticamente
                    await ensureLeadExists(cleanJid, companyId, incomingName);
                }
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

// --- CORE: ENSURE LEAD (Com Mutex) ---
export const ensureLeadExists = async (jid, companyId, pushName, myBotJid = null) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    const cleanJid = normalizeJid(jid);
    
    // Proteção Anti Self-Lead (Bot não cria lead dele mesmo)
    if (myBotJid) {
        const cleanBot = normalizeJid(myBotJid);
        if (cleanJid === cleanBot) return null;
        
        const phoneA = await resolveRealPhone(cleanJid, companyId);
        const phoneB = await resolveRealPhone(cleanBot, companyId);
        if (phoneA && phoneB && phoneA === phoneB) return null;
    }

    const realPhone = await resolveRealPhone(cleanJid, companyId);
    
    // Validação mínima de telefone
    if (!realPhone || (realPhone.length > 14 && !realPhone.startsWith('55'))) {
        return null;
    }

    // MUTEX: Evita criar leads duplicados se receber 10 mensagens simultâneas
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
            // Cura nomes ruins se chegar um nome bom
            if (nameIsValid && (!existing.name || isGenericName(existing.name, realPhone))) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // Tenta buscar nome na tabela de contatos se pushName for ruim
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

        // Busca o primeiro estágio do funil
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        // Cria o Lead
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
        // Libera o lock após 1 segundo
        setTimeout(() => leadLock.delete(lockKey), 1000);
    }
};

// --- CORE: UPSERT MESSAGE ---
export const upsertMessage = async (msgData) => {
    try {
        // Delay tático para garantir que o contato/lead já exista (Integridade FK)
        await new Promise(resolve => setTimeout(resolve, 50)); 
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        const finalData = { ...msgData, remote_jid: cleanRemoteJid };
        
        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
    } catch (e) {
        // Silencioso em produção, mas logado se for erro grave
        // console.error("Msg Error", e.message);
    }
};

// Placeholders para manter compatibilidade
export const savePollVote = async (msg, companyId) => {};
export const deleteSessionData = async (sessionId) => {
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};
export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
