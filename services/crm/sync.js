
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase com Service Role (Ignora RLS)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Mutex
const leadLock = new Set(); 

// --- NAME SANITIZER V6.3 ---
const isGenericName = (name) => {
    if (!name) return true;
    const clean = String(name).trim();
    if (clean.length < 1) return true;
    // Verifica se tem letras. Se não tiver (só números/símbolos), é genérico.
    const hasLetters = /[a-zA-Z\u00C0-\u00FF]/.test(clean);
    return !hasLetters; 
};

// Helper para formatar telefone bonito (+55 11...) quando não temos nome
const formatPhoneAsName = (phone) => {
    if (!phone) return "Desconhecido";
    const p = phone.replace(/\D/g, '');
    if (p.length >= 12 && p.startsWith('55')) {
        const ddd = p.substring(2, 4);
        const num = p.substring(4);
        const part1 = num.length === 9 ? num.substring(0, 5) : num.substring(0, 4);
        const part2 = num.length === 9 ? num.substring(5) : num.substring(4);
        return `+55 (${ddd}) ${part1}-${part2}`;
    }
    return `+${p}`;
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {}
};

// PATCH: Sincronização Agressiva (Contact -> Lead)
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false) => {
    try {
        if (!jid || !companyId) return;

        const isGroup = jid.includes('@g.us');
        const cleanJid = jid.split('@')[0].split(':')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
        const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
        
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date(),
            last_message_at: new Date()
        };

        const nameValid = !isGenericName(incomingName);

        if (nameValid) {
            updateData.push_name = incomingName;
            if (isFromBook) {
                updateData.name = incomingName;
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // 2. Upsert Contato
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // 3. AUTO-HEALING & CREATION DE LEADS
        // Se veio da agenda (isFromBook) ou se temos um nome válido, propagamos.
        if (!error && !isGroup) {
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone)
                .limit(1)
                .maybeSingle();

            if (lead) {
                // Atualiza se nome atual for ruim ou diferente da agenda
                const currentNameBad = !lead.name || isGenericName(lead.name);
                
                // Se temos um nome bom chegando, atualizamos o lead
                if (nameValid && (currentNameBad || (isFromBook && lead.name !== incomingName))) {
                    await supabase.from('leads').update({ name: incomingName }).eq('id', lead.id);
                }
            } else if (isFromBook && nameValid) {
                // Se não existe e veio da agenda, cria imediatamente
                const { data: stage } = await supabase.from('pipeline_stages')
                    .select('id')
                    .eq('company_id', companyId)
                    .order('position', { ascending: true })
                    .limit(1)
                    .maybeSingle();
                
                await supabase.from('leads').insert({
                    company_id: companyId,
                    phone: purePhone,
                    name: incomingName,
                    status: 'new',
                    pipeline_stage_id: stage?.id
                });
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

// Garante criação do Lead (Com trava de concorrência)
export const ensureLeadExists = async (jid, companyId, pushName) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    const purePhone = jid.split('@')[0].replace(/\D/g, '');
    if (purePhone.length < 8) return null;
    
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: existing } = await supabase.from('leads')
            .select('id, name')
            .eq('phone', purePhone)
            .eq('company_id', companyId)
            .maybeSingle();

        // LÓGICA DE NOME (FALLBACK V6.3)
        // Se pushName for válido, usa ele.
        // Se não for, usa o número formatado como nome provisório.
        const nameIsValid = !isGenericName(pushName);
        const fallbackName = formatPhoneAsName(purePhone);
        const nameToUse = nameIsValid ? pushName : fallbackName;

        if (existing) {
            // Self-Healing: Se o nome atual for genérico/nulo e agora temos um nome válido, atualiza.
            // Se o nome atual for o número formatado (fallback) e chegou um pushName real, atualiza.
            const currentIsBad = !existing.name || isGenericName(existing.name) || existing.name.includes('+55');
            
            if (nameIsValid && currentIsBad) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // Create
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: purePhone,
            name: nameToUse, // Nunca será NULL agora
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
        await new Promise(resolve => setTimeout(resolve, 200));
        const { error } = await supabase.from('messages').upsert(msgData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
    } catch (e) {}
};

export const savePollVote = async (msg, companyId) => {};
export const deleteSessionData = async (sessionId) => {
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};
export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
