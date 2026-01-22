
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

const leadLock = new Set(); 

// --- NAME SANITIZER BLINDADO V5.3 ---
// Retorna TRUE se o nome for inválido, nulo, ou apenas números/símbolos
const isGenericName = (name) => {
    if (!name) return true;
    const clean = name.toString().trim();
    if (clean.length === 0) return true;
    
    // Se NÃO tiver nenhuma letra, é genérico (ex: "55119999" ou "+55 (11)...")
    // Isso garante que "1001 Utilidades" seja aceito, mas "5511999" não.
    const hasLetters = /[a-zA-Z]/.test(clean);
    return !hasLetters; 
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {}
};

// PATCH: Sincronização de Nomes Robusta
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false) => {
    try {
        if (!jid || !companyId) return;

        const isGroup = jid.includes('@g.us');
        // Normaliza JID para formato padrão do banco
        const cleanJid = jid.split('@')[0].split(':')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
        
        // EXTRAÇÃO DE TELEFONE PURO (Para match com Leads)
        // Remove tudo que não for número do JID para garantir match com a coluna 'phone' do lead
        const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
        
        // 1. Busca dados atuais do contato
        const { data: current } = await supabase
            .from('contacts')
            .select('name, push_name, profile_pic_url')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        const updateData = {
            jid: cleanJid,
            phone: purePhone, // Salva o telefone limpo no contato também
            company_id: companyId,
            updated_at: new Date(),
            last_message_at: new Date()
        };

        // --- LÓGICA DE PRIORIDADE (NAME HUNTER V5.3) ---
        // Agora verificamos apenas se é genérico (só numeros/simbolos)
        const incomingIsGood = !isGenericName(incomingName);
        const currentIsGood = current && !isGenericName(current.name);

        // Define o "Melhor Nome" para salvar
        let nameToPersist = null;

        if (incomingIsGood) {
            updateData.push_name = incomingName; // Sempre atualiza push_name se bom
            
            // Sobrescreve se: Veio da Agenda (Autoridade) OU Banco atual é ruim/genérico
            if (isFromBook || !currentIsGood) {
                updateData.name = incomingName;
                nameToPersist = incomingName;
            } else {
                // Se não veio da agenda e o banco já tem nome bom, mantemos o do banco
                nameToPersist = current.name;
            }
        } else {
            // Se o novo nome é ruim, mantemos o antigo se for bom
            nameToPersist = currentIsGood ? current.name : null;
            if (!currentIsGood) updateData.name = null; // Limpa lixo se ambos ruins
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // Executa UPSERT no CONTACTS
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // --- PROPAGAÇÃO PARA LEADS (FIX DEFINITIVO) ---
        // Se temos um nome válido (nameToPersist) e não é grupo, forçamos a atualização no Lead
        if (!error && nameToPersist && !isGroup) {
            
            // Busca o Lead pelo telefone numérico exato
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone) // Match exato numérico
                .limit(1)
                .maybeSingle();

            if (lead) {
                // Se o nome do Lead for diferente do "Melhor Nome" OU se o nome do Lead for genérico
                // ATUALIZA! Isso corrige leads criados com nome = telefone.
                if (lead.name !== nameToPersist || isGenericName(lead.name)) {
                    await supabase.from('leads')
                        .update({ name: nameToPersist })
                        .eq('id', lead.id);
                }
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

export const ensureLeadExists = async (jid, companyId, pushName) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    // Extração pura de números
    const purePhone = jid.split('@')[0].replace(/\D/g, '');
    if (purePhone.length < 8) return null;
    
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: existing } = await supabase.from('leads')
            .select('id, name')
            .eq('phone', purePhone) // Match numérico
            .eq('company_id', companyId)
            .maybeSingle();

        if (existing) {
            // Self-Healing: Se o lead existe mas tem nome genérico, e temos um pushName válido, atualiza
            if (pushName && !isGenericName(pushName) && isGenericName(existing.name)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        const nameToUse = (pushName && !isGenericName(pushName)) ? pushName : null;
        
        const { data: stage } = await supabase.from('pipeline_stages').select('id').eq('company_id', companyId).order('position', { ascending: true }).limit(1).maybeSingle();

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: purePhone,
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
