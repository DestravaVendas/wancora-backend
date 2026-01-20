
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

const leadLock = new Set(); 

// --- NAME SANITIZER ---
// Retorna TRUE se for lixo (número puro, undefined, null)
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length === 0) return true;
    
    // Se o nome for igual ao telefone (com ou sem DDI)
    const cleanPhone = phone.replace(/\D/g, '');
    const cleanNameDigits = cleanName.replace(/\D/g, '');
    
    // Regra: Se o nome for só números, é genérico.
    if (/^[\d\s\+\-\(\)]+$/.test(cleanName)) return true;
    
    if (cleanNameDigits === cleanPhone) return true; // É o próprio número
    
    return false;
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {}
};

export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null) => {
    try {
        if (!jid || !companyId) return;

        const isGroup = jid.includes('@g.us');
        // Normaliza JID (remove dispositivo :2, etc)
        const cleanJid = jid.split('@')[0].split(':')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
        const phone = cleanJid.split('@')[0];
        
        // 1. Busca dados atuais (Leitura leve)
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
            last_message_at: new Date() // Mantém o contato "vivo"
        };

        // --- LÓGICA DE ATUALIZAÇÃO DE NOME (AGRESSIVA v2) ---
        let finalName = null;
        let shouldUpdateLead = false;
        
        const incomingIsGood = !isGenericName(incomingName, phone);
        const currentIsGood = current && !isGenericName(current.name, phone);

        if (incomingIsGood) {
            // Sempre salvamos o push_name se vier algo bom
            updateData.push_name = incomingName; 

            // Se não temos um nome bom no banco, aceitamos o novo imediatamente
            if (!currentIsGood) {
                updateData.name = incomingName;
                finalName = incomingName;
                shouldUpdateLead = true;
                // console.log(`[NAME HUNTER] Salvando novo nome: ${incomingName} para ${phone}`);
            } 
        } else {
            // Se o que chegou é ruim (null ou número), mas não temos nada no banco
            // Forçamos NULL para evitar salvar o número como nome (regra do sanitizer)
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
            // [PROPAGAÇÃO PARA LEADS]
            // Se descobrimos um nome novo para o contato, atualiza o Lead
            // MAS APENAS se o Lead estiver sem nome ou com nome genérico
            
            // 1. Busca Lead Existente
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .ilike('phone', `%${phone}%`)
                .limit(1)
                .maybeSingle();

            // 2. Se existir e o nome for ruim, atualiza
            if (lead) {
                if (isGenericName(lead.name, phone)) {
                    await supabase.from('leads').update({ name: finalName }).eq('id', lead.id);
                    // console.log(`[LEAD SYNC] Nome do lead atualizado: ${finalName}`);
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
            // Atualiza nome do lead existente se ele não tiver nome bom e o novo for bom
            if (pushName && !isGenericName(pushName, phone) && isGenericName(existing.name, phone)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // [NOVO LEAD]
        // Se tem nome válido, usa. Se não, usa NULL (deixa o frontend lidar ou futura atualização)
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
