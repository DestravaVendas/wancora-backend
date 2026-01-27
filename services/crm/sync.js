
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Cache removido da lógica crítica para garantir salvamento agressivo
const contactCache = new Set();
const leadLock = new Set(); 

// --- FUNÇÃO AUXILIAR BLINDADA (NAME HUNTER) ---
// Retorna TRUE se o nome for apenas um número, símbolo ou genérico
const isGenericName = (name, phone) => {
    if (!name) return true;
    
    // Limpa tudo que não é dígito para comparação bruta
    const cleanName = name.replace(/\D/g, ''); 
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Regra: Se o nome só tem números e símbolos
    const isJustNumbersAndSymbols = /^[\d\+\-\(\)\s]+$/.test(name);

    return cleanName.includes(cleanPhone) || 
           name === phone || 
           name.startsWith('+') || 
           isJustNumbersAndSymbols ||
           (cleanName.length > 7 && /[0-9]{5,}/.test(name));
};

// --- HELPER: JID NORMALIZATION ---
export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid.split('@')[0] + '@g.us';
    if (jid.includes('@newsletter')) return jid; // FIX: Suporte a Canais
    if (jid.includes('@lid')) return jid; // Mantém LID para o mapa de identidade
    return jid.split('@')[0].split(':')[0] + '@s.whatsapp.net';
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {}
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

export const upsertContact = async (jid, companyId, pushName = null, profilePicUrl = null, isFromBook = false, lidJid = null) => {
    try {
        if (!jid || !companyId) return;

        const cleanJid = normalizeJid(jid);
        const isGroup = cleanJid.includes('@g.us');
        const isNewsletter = cleanJid.includes('@newsletter'); // FIX: Identificação de Canal
        
        // 1. Identity Resolution: Mapeia LID -> Phone JID
        if (lidJid && !isGroup && !isNewsletter) {
            await supabase.from('identity_map').upsert({
                lid_jid: normalizeJid(lidJid),
                phone_jid: cleanJid, 
                company_id: companyId
            }, { onConflict: 'lid_jid' });
        }

        // Define o telefone para salvar na coluna 'phone'
        // FIX: Canais não têm telefone, usamos '0' ou o próprio ID para manter a integridade
        let phoneColumnValue = '0';
        
        if (!isNewsletter) {
            phoneColumnValue = cleanJid.split('@')[0].replace(/\D/g, '');
            if (cleanJid.includes('@lid')) {
                const realPhone = await resolveRealPhone(cleanJid, companyId);
                if (realPhone && !realPhone.includes('@lid')) {
                    phoneColumnValue = realPhone.replace(/\D/g, '');
                }
            }
        }
        
        const { data: current } = await supabase
            .from('contacts')
            .select('name, push_name, profile_pic_url')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        const updateData = {
            jid: cleanJid,
            phone: phoneColumnValue,
            company_id: companyId,
            updated_at: new Date(),
            last_message_at: new Date()
        };

        let finalName = current?.name;
        let shouldUpdateLead = false;

        // --- LÓGICA DE PRIORIDADE (NAME HUNTER) ---
        // Ignora validação de nome genérico para Newsletters (geralmente o nome é o ID ou PushName direto)
        if (pushName && pushName.trim().length > 0 && (!isGenericName(pushName, phoneColumnValue) || isNewsletter)) {
            updateData.push_name = pushName;
            
            const currentName = current?.name;
            const isCurrentBad = !currentName || isGenericName(currentName, phoneColumnValue);

            // Se o nome atual no banco for ruim (NULL ou Número), sobrescreve!
            if (isCurrentBad || isFromBook) {
                updateData.name = pushName;
                finalName = pushName;    
                shouldUpdateLead = true; 
            }
        } else if (!current) {
            updateData.name = null; 
            finalName = null; 
        } else if (current && isGenericName(current.name, phoneColumnValue) && !isNewsletter) {
            updateData.name = null;
        }

        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
        }

        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        if (error) {
             console.error('[CONTACT SYNC ERROR]', error.message);
        } else if (shouldUpdateLead && finalName && !isGroup && !isNewsletter) {
            // Propaga para o Lead se existir (Apenas contatos reais)
            await ensureLeadExists(cleanJid, companyId, finalName);
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

export const ensureLeadExists = async (jid, companyId, pushName, myBotJid = null) => {
    // Bloqueios de segurança
    if (!jid || jid.endsWith('@g.us') || jid.includes('-') || jid.includes('status@broadcast') || jid.endsWith('@newsletter') || jid.endsWith('@lid')) {
        return null; 
    }

    const cleanJid = normalizeJid(jid);
    
    // Proteção Anti Self-Lead (Bot não cria lead dele mesmo)
    if (myBotJid) {
        const cleanBot = normalizeJid(myBotJid);
        if (cleanJid === cleanBot) return null;
    }

    const phone = jid.split('@')[0];
    if (!/^\d+$/.test(phone)) return null;
    
    const lockKey = `${companyId}:${phone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: existing } = await supabase.from('leads').select('id, name').eq('phone', phone).eq('company_id', companyId).maybeSingle();

        if (existing) {
            // Se achou nome melhor agora, atualiza
            // AQUI TAMBÉM: Só atualiza se o nome atual for ruim.
            if (pushName && !isGenericName(pushName, phone) && isGenericName(existing.name, phone)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // [SEM LEAD 1234]
        // Se tem nome válido, usa. Se não, usa NULL.
        const nameToUse = (pushName && !isGenericName(pushName, phone)) ? pushName : null;
        
        const { data: stage } = await supabase.from('pipeline_stages').select('id').eq('company_id', companyId).order('position', { ascending: true }).limit(1).maybeSingle();

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: phone,
            name: nameToUse,
            status: 'new',
            pipeline_stage_id: stage?.id
        }).select('id').single();

        return newLead?.id;
    } catch (e) {
        logger.error({ err: e.message }, 'Erro ensureLeadExists');
        return null;
    } finally {
        leadLock.delete(lockKey);
    }
};

export const upsertMessage = async (msgData) => {
    try {
        // Delay UX mantido
        await new Promise(resolve => setTimeout(resolve, 250));
        const { error } = await supabase.from('messages').upsert(msgData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertMessage');
    }
};

export const savePollVote = async (msg, companyId) => {};

// Atualizado para aceitar companyId e limpar corretamente
export const deleteSessionData = async (sessionId, companyId) => {
    await supabase.from('instances')
        .update({ status: 'disconnected', qrcode_url: null })
        .eq('session_id', sessionId); // companyId opcional aqui pois sessionId é único
        
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};

// FIX DO ERRO DE DEPLOY: Esta função estava faltando
export const updateInstanceStatus = async (sessionId, companyId, data) => {
    await supabase.from('instances')
        .update({ ...data, updated_at: new Date() })
        .eq('session_id', sessionId)
        .eq('company_id', companyId);
};
