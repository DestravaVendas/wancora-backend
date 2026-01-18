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

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {}
};

export const upsertContact = async (jid, companyId, pushName = null, profilePicUrl = null) => {
    try {
        if (!jid || !companyId) return;

        const isGroup = jid.includes('@g.us');
        const cleanJid = jid.split('@')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
        const phone = cleanJid.split('@')[0];
        
        const { data: current } = await supabase
            .from('contacts')
            .select('name, push_name, profile_pic_url')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        const updateData = {
            jid: cleanJid,
            phone: phone,
            company_id: companyId,
            updated_at: new Date(),
            last_message_at: new Date()
        };

        let finalName = current?.name;
        let shouldUpdateLead = false;

        // --- LÓGICA DE PRIORIDADE (NAME HUNTER) ---
        if (pushName && pushName.trim().length > 0 && !isGenericName(pushName, phone)) {
            updateData.push_name = pushName;
            
            const currentName = current?.name;
            const isCurrentBad = !currentName || isGenericName(currentName, phone);

            // Se o nome atual no banco for ruim, sobrescreve!
            if (isCurrentBad) {
                updateData.name = pushName;
                finalName = pushName;    
                shouldUpdateLead = true; 
            }
        } else if (!current) {
            // Contato novo sem nome? Manda NULL (Trigger do banco resolve).
            updateData.name = null; 
            finalName = null; 
        } else if (current && isGenericName(current.name, phone)) {
            // Se já existe mas é número, limpa para NULL
            updateData.name = null;
        }

        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
        }

        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        if (error) {
            console.error('[CONTACT SYNC ERROR]', error.message);
        } else if (shouldUpdateLead && finalName && !isGroup) {
            // Atualiza Lead apenas se descobrimos um nome REAL
            await supabase.from('leads')
                .update({ name: finalName })
                .eq('company_id', companyId)
                .eq('phone', phone)
                .neq('name', finalName); 
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

export const ensureLeadExists = async (jid, companyId, pushName) => {
    // Bloqueios de segurança
    if (!jid || jid.endsWith('@g.us') || jid.includes('-') || jid.includes('status@broadcast') || jid.endsWith('@newsletter') || jid.endsWith('@lid')) {
        return null; 
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
            if (pushName && !isGenericName(pushName, phone) && isGenericName(existing.name, phone)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // Se tem nome, usa. Se não, usa o telefone puro.
        const nameToUse = (pushName && !isGenericName(pushName, phone)) ? pushName : phone;
        
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
        // Delay de 250ms mantido para UX do Frontend
        await new Promise(resolve => setTimeout(resolve, 250));
        
        const { error } = await supabase.from('messages').upsert(msgData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertMessage');
    }
};

export const savePollVote = async (msg, companyId) => {};
export const deleteSessionData = async (sessionId) => {
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};
export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
