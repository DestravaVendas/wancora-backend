
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

const leadLock = new Set(); 

// --- NAME SANITIZER BLINDADO V5.1 ---
// Retorna TRUE se o nome for lixo ou parecer um número de telefone
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length === 0) return true;
    
    // Regra 1: Apenas símbolos ou números
    if (/^[\d\s\+\-\(\)\.]+$/.test(cleanName)) return true;
    
    // Regra 2: Comparação direta com o telefone (ignora +55, espaços, traços)
    const cleanPhone = phone.replace(/\D/g, '');
    const cleanNameDigits = cleanName.replace(/\D/g, '');
    
    // Se o nome contiver pelo menos 8 dígitos e for igual ao telefone, é genérico
    if (cleanNameDigits.length > 7 && cleanNameDigits.includes(cleanPhone)) return true;
    if (cleanNameDigits === cleanPhone) return true;
    
    return false;
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {}
};

// PATCH: Adicionado parâmetro `isFromBook`
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false) => {
    try {
        if (!jid || !companyId) return;

        const isGroup = jid.includes('@g.us');
        // Normaliza JID
        const cleanJid = jid.split('@')[0].split(':')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
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

        // --- LÓGICA DE PRIORIDADE (NAME HUNTER V5.1) ---
        let finalName = null;
        let shouldUpdateLead = false;
        
        const incomingIsGood = !isGenericName(incomingName, phone);
        const currentIsGood = current && !isGenericName(current.name, phone);

        if (incomingIsGood) {
            // Sempre salvamos push_name se vier algo válido
            updateData.push_name = incomingName; 

            // Regra de Ouro:
            // - Se o banco tem nome ruim -> ATUALIZA
            // - Se veio da Agenda -> ATUALIZA (Autoridade)
            // - Se o banco já tem nome bom e não veio da agenda -> PRESERVA (Não deixa pushName sobrescrever Agenda)
            const shouldOverwrite = !currentIsGood || isFromBook;

            if (shouldOverwrite) {
                if (!current || current.name !== incomingName) {
                    updateData.name = incomingName;
                    finalName = incomingName;
                    shouldUpdateLead = true;
                }
            } 
        } else {
            // Se chegou nome ruim e não temos nada, força NULL para limpar lixo
            if (!current && !currentIsGood) {
                updateData.name = null;
            }
        }

        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
        }

        // Executa UPSERT
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        if (error) {
             console.error('[CONTACT SYNC ERROR]', error.message);
        } else if (shouldUpdateLead && finalName && !isGroup) {
            // Propagação para Leads
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .ilike('phone', `%${phone}%`)
                .limit(1)
                .maybeSingle();

            if (lead) {
                // Só atualiza Lead se o nome atual dele for ruim ou se a fonte for confiável (Agenda)
                if (isGenericName(lead.name, phone) || isFromBook) {
                    await supabase.from('leads').update({ name: finalName }).eq('id', lead.id);
                }
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

export const ensureLeadExists = async (jid, companyId, pushName) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    const phone = jid.split('@')[0].split(':')[0]; // Clean phone
    if (!/^\d+$/.test(phone)) return null;
    
    const lockKey = `${companyId}:${phone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: existing } = await supabase.from('leads').select('id, name').eq('phone', phone).eq('company_id', companyId).maybeSingle();

        if (existing) {
            // Se o lead existe mas tem nome genérico (número), tenta atualizar com o pushName
            if (pushName && !isGenericName(pushName, phone) && isGenericName(existing.name, phone)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

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
        return null;
    } finally {
        leadLock.delete(lockKey);
    }
};

export const upsertMessage = async (msgData) => {
    try {
        // Pequeno delay para garantir que o contato foi criado antes da mensagem
        await new Promise(resolve => setTimeout(resolve, 150));
        const { error } = await supabase.from('messages').upsert(msgData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
    } catch (e) {
        // logger.error({ err: e.message }, 'Erro upsertMessage');
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
