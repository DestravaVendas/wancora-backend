
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
        
        // 1. Busca dados atuais
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

        // --- LÓGICA DE OURO: NAME HUNTER ---
        let finalName = null;
        let shouldUpdateLead = false;
        
        const incomingNameValid = pushName && pushName.trim().length > 0 && !isGenericName(pushName, phone);
        const currentNameValid = current?.name && !isGenericName(current.name, phone);

        // LOG DE DIAGNÓSTICO
        // console.log(`[NAME_HUNTER] JID: ${phone} | Incoming: "${pushName}" | Current DB: "${current?.name}"`);

        if (incomingNameValid) {
            // Se chegou um nome bom...
            updateData.push_name = pushName; // Sempre atualiza o push_name com o mais recente

            if (!currentNameValid) {
                // ...e o banco está vazio ou com número -> SALVA O NOME NOVO
                updateData.name = pushName;
                finalName = pushName;
                shouldUpdateLead = true;
                // console.log(`[NAME_HUNTER] Atualizando Nome: ${pushName}`);
            } else {
                // ...mas o banco já tem um nome bom -> MANTÉM O DO BANCO (Ignora)
                // console.log(`[NAME_HUNTER] Mantendo existente: ${current.name}`);
            }
        } else {
            // Se chegou nome ruim (ou null)...
            if (!currentNameValid && !current) {
                // ...e não existe nada no banco -> FORÇA NULL (Nunca salve número como nome)
                updateData.name = null;
                // console.log(`[NAME_HUNTER] Salvando NULL (Nome genérico/vazio)`);
            }
        }

        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
        }

        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        if (error) {
             console.error('[CONTACT SYNC ERROR]', error.message);
        } else if (shouldUpdateLead && finalName && !isGroup) {
            // [PROPAGAÇÃO PARA LEADS]
            // Se descobrimos um nome novo para o contato, atualiza o Lead também
            const { error: leadError } = await supabase
                .from('leads')
                .update({ name: finalName })
                .eq('company_id', companyId)
                .ilike('phone', `%${phone}%`) // Match flexível pelo telefone
                .is('name', null); // SÓ ATUALIZA SE O LEAD ESTIVER SEM NOME (Regra de Ouro)
            
            if (leadError) console.error('[LEAD SYNC ERROR]', leadError.message);
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
            // Se achou nome melhor agora e o lead atual tem nome ruim/null, atualiza
            if (pushName && !isGenericName(pushName, phone)) {
                 if (!existing.name || isGenericName(existing.name, phone)) {
                    await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
                 }
            }
            return existing.id;
        }

        // [SEM LEAD]
        // Se tem nome válido, usa. Se não, usa NULL (Regra: Nunca salvar número como nome)
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
export const deleteSessionData = async (sessionId) => {
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};
export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
