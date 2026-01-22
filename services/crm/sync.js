import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase com Service Role (Ignora RLS)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Mutex para evitar criação duplicada
const leadLock = new Set(); 

// --- NAME SANITIZER V6.0 ---
// Retorna TRUE se o nome for ruim (nulo, só números, sem letras)
const isGenericName = (name) => {
    if (!name) return true;
    const clean = String(name).trim();
    if (clean.length < 1) return true;
    
    // Deve conter letras. Se for só "+55..." ou "12345", retorna true (é genérico)
    const hasLetters = /[a-zA-Z\u00C0-\u00FF]/.test(clean);
    return !hasLetters; 
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
        
        // 1. Dados para o Contato
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
            // Se veio da agenda, forçamos o 'name'. Se não, deixamos o banco decidir.
            if (isFromBook) {
                updateData.name = incomingName;
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // 2. Upsert Contato
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // 3. AUTO-HEALING DE LEADS (A Correção Principal)
        // Se temos um nome válido, tentamos corrigir o Lead imediatamente
        if (!error && nameValid && !isGroup) {
            
            // Busca o Lead apenas pelo telefone numérico
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone)
                .limit(1)
                .maybeSingle();

            if (lead) {
                // LÓGICA DE OURO v6.0:
                // Atualiza SE: 
                // 1. O nome do lead atual é NULO
                // 2. OU O nome do lead atual é genérico (só numero)
                // 3. OU Veio da Agenda (Autoridade Máxima)
                const currentNameBad = !lead.name || isGenericName(lead.name);
                
                if (currentNameBad || isFromBook) {
                    // Só atualiza se o novo nome for diferente do atual
                    if (lead.name !== incomingName) {
                        await supabase.from('leads')
                            .update({ name: incomingName })
                            .eq('id', lead.id);
                    }
                }
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

// Garante criação do Lead
export const ensureLeadExists = async (jid, companyId, pushName) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    const purePhone = jid.split('@')[0].replace(/\D/g, '');
    if (purePhone.length < 8) return null;
    
    const lockKey = `${companyId}:${purePhone}`;
    
    // Se já estamos criando este lead, retorna null para evitar duplicidade no DB
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: existing } = await supabase.from('leads')
            .select('id, name')
            .eq('phone', purePhone)
            .eq('company_id', companyId)
            .maybeSingle();

        // Se existe, fazemos o Auto-Healing aqui também
        if (existing) {
            // Se o lead tem nome ruim e chegou um nome bom -> Atualiza
            if (!isGenericName(pushName) && (isGenericName(existing.name) || !existing.name)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // Se não existe, cria
        const nameToUse = !isGenericName(pushName) ? pushName : null;
        
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: purePhone,
            name: nameToUse, // Tenta já criar com nome se possível
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
