
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

const leadLock = new Set(); 

// --- FUNÇÃO AUXILIAR BLINDADA (NAME HUNTER V5) ---
// Retorna TRUE se o nome for inválido, genérico ou apenas o número formatado
const isGenericName = (name, phone) => {
    if (!name) return true;
    const n = name.toString().trim();
    if (n.length === 0) return true;
    if (n.toLowerCase() === 'usuário' || n.toLowerCase() === 'user' || n.toLowerCase() === 'contato') return true;
    
    // Limpa tudo que não é dígito para comparação bruta
    const cleanName = n.replace(/\D/g, ''); 
    const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    
    // Se o nome contém o telefone (ex: "+55 11 9999-9999")
    if (cleanPhone && cleanName.includes(cleanPhone)) return true;

    // Regra: Se o nome só tem números e símbolos (ex: "+55 11...")
    const isJustNumbersAndSymbols = /^[\d\+\-\(\)\s]+$/.test(n);

    return isJustNumbersAndSymbols || (cleanName.length > 6 && /^[0-9]+$/.test(cleanName));
};

// --- HELPER: JID NORMALIZATION ---
export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid.split('@')[0] + '@g.us';
    if (jid.includes('@newsletter')) return jid; 
    if (jid.includes('@lid')) return jid; 
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
    if (jid.includes('@s.whatsapp.net') && !jid.includes('@lid')) return jid.split('@')[0];
    
    if (jid.includes('@lid')) {
        const { data } = await supabase.from('identity_map')
            .select('phone_jid')
            .eq('lid_jid', jid)
            .eq('company_id', companyId)
            .maybeSingle();
        if (data?.phone_jid) return data.phone_jid.split('@')[0];
    }
    return jid.split('@')[0];
};

export const upsertContact = async (jid, companyId, pushName = null, profilePicUrl = null, isFromBook = false, lidJid = null) => {
    try {
        if (!jid || !companyId) return;

        const cleanJid = normalizeJid(jid);
        const isGroup = cleanJid.includes('@g.us');
        const isNewsletter = cleanJid.includes('@newsletter');
        
        // 1. Identity Resolution
        if (lidJid && !isGroup && !isNewsletter) {
            await supabase.from('identity_map').upsert({
                lid_jid: normalizeJid(lidJid),
                phone_jid: cleanJid, 
                company_id: companyId
            }, { onConflict: 'lid_jid' });
        }

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
        if (pushName && pushName.trim().length > 0 && (!isGenericName(pushName, phoneColumnValue) || isNewsletter)) {
            updateData.push_name = pushName;
            
            const currentName = current?.name;
            const isCurrentBad = !currentName || isGenericName(currentName, phoneColumnValue);

            // Se veio da Agenda (isFromBook) OU o nome atual é ruim, atualiza
            if (isCurrentBad || isFromBook) {
                updateData.name = pushName;
                finalName = pushName;    
                shouldUpdateLead = true; 
            }
        } else if (!current) {
            updateData.name = null; // Garante null em vez de "undefined"
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        if (!error && shouldUpdateLead && finalName && !isGroup && !isNewsletter) {
            // Propaga melhoria de nome para o Lead existente
            await ensureLeadExists(cleanJid, companyId, finalName);
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

export const ensureLeadExists = async (jid, companyId, pushName, myBotJid = null) => {
    // 1. Bloqueios de segurança (Protocolo Anti-Lixo)
    if (!jid || 
        jid.endsWith('@g.us') || 
        jid.includes('status@broadcast') || 
        jid.endsWith('@newsletter') || 
        jid.endsWith('@lid')) {
        return null; 
    }

    const cleanJid = normalizeJid(jid);
    
    // 2. Proteção Anti Self-Lead (Eu não sou meu próprio lead)
    if (myBotJid) {
        const cleanBot = normalizeJid(myBotJid);
        // Compara ignorando sufixo de server para garantir
        if (cleanJid.split('@')[0] === cleanBot.split('@')[0]) return null;
    }

    const phone = jid.split('@')[0].replace(/\D/g, '');
    if (!/^\d+$/.test(phone) || phone.length < 5) return null;
    
    const lockKey = `${companyId}:${phone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: existing } = await supabase.from('leads').select('id, name').eq('phone', phone).eq('company_id', companyId).maybeSingle();

        // 3. Self-Healing: Se o lead existe mas tem nome ruim, melhora agora
        if (existing) {
            if (pushName && !isGenericName(pushName, phone) && isGenericName(existing.name, phone)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 4. Criação de Novo Lead
        const nameToUse = (pushName && !isGenericName(pushName, phone)) ? pushName : null; // Nunca cria com nome genérico
        
        const { data: stage } = await supabase.from('pipeline_stages').select('id').eq('company_id', companyId).order('position', { ascending: true }).limit(1).maybeSingle();

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: phone,
            name: nameToUse,
            status: 'new',
            pipeline_stage_id: stage?.id,
            position: Date.now() // Garante ordem no Kanban
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

export const deleteSessionData = async (sessionId, companyId) => {
    await supabase.from('instances')
        .update({ status: 'disconnected', qrcode_url: null })
        .eq('session_id', sessionId);
        
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};

export const updateInstanceStatus = async (sessionId, companyId, data) => {
    await supabase.from('instances')
        .update({ ...data, updated_at: new Date() })
        .eq('session_id', sessionId)
        .eq('company_id', companyId);
};
