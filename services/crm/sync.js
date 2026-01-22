
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase com Service Role (Ignora RLS para o Backend)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Mutex para evitar Race Conditions na criação de Leads em rajadas
const leadLock = new Set(); 

// --- HELPER: NAME VALIDATION ---
// Retorna TRUE se o nome for inválido (apenas números, símbolos, nulo ou curto demais)
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    if (cleanName.toLowerCase() === 'null' || cleanName.toLowerCase() === 'undefined') return true; // Proteção contra logs
    
    // Se o nome for igual ao telefone (com ou sem formatação)
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;

    // Regex: Deve conter pelo menos uma letra (latinas ou acentuadas)
    const hasLetters = /[a-zA-Z\u00C0-\u00FF]/.test(cleanName);
    return !hasLetters; 
};

// --- HELPER: JID NORMALIZATION (CORE FIX) ---
// Remove sufixos de dispositivo (:1, :2) para garantir agrupamento correto
export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid.split('@')[0] + '@g.us';
    // Remove qualquer coisa após o : e antes do @, ou apenas mantem o numero antes do @
    const user = jid.split('@')[0].split(':')[0];
    return `${user}@s.whatsapp.net`;
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {}
};

// --- SYNC CONTACTS (AGENDA & METADADOS) ---
// isFromBook = true significa que a fonte é a agenda do celular (Autoridade Máxima)
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false) => {
    try {
        if (!jid || !companyId) return;
        if (jid.includes('status@broadcast')) return;

        // NORMALIZAÇÃO CRÍTICA: Garante que o JID salvo seja sempre limpo
        const cleanJid = normalizeJid(jid);
        const isGroup = cleanJid.includes('@g.us');
        const purePhone = cleanJid.split('@')[0].replace(/\D/g, ''); 
        
        // 1. Prepara dados do contato para tabela 'contacts'
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date()
        };

        // VALIDAÇÃO DE NOME (Name Hunter)
        const nameIsValid = !isGenericName(incomingName, purePhone);

        if (nameIsValid) {
            // Sempre salvamos o push_name se ele for válido
            updateData.push_name = incomingName;
            
            // SE veio da agenda (isFromBook), forçamos o 'name' (Agenda > PushName)
            if (isFromBook) {
                updateData.name = incomingName;
            }
        } else {
            // SE O NOME É RUIM, NÃO SALVA NADA NO 'name' SE FOR NOVO
            // Deixa NULL para o frontend tratar visualmente
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // 2. Upsert na tabela contacts
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // 3. LEAD SELF-HEALING (A Cura)
        if (!error && !isGroup) {
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone)
                .limit(1)
                .maybeSingle();

            if (lead) {
                // Se temos um nome válido e o lead está com nome NULL ou Genérico, atualizamos
                const currentNameIsBad = !lead.name || isGenericName(lead.name, purePhone);
                
                if (nameIsValid && (currentNameIsBad || isFromBook)) {
                    await supabase.from('leads').update({ name: incomingName }).eq('id', lead.id);
                }
            } else if (isFromBook && nameIsValid) {
                // Se veio da Agenda e tem nome válido, cria Lead
                await ensureLeadExists(cleanJid, companyId, incomingName);
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

// --- GARANTIA DE LEAD (Criação ou Busca) ---
export const ensureLeadExists = async (jid, companyId, pushName) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    // Garante JID limpo e Telefone Puro
    const cleanJid = normalizeJid(jid);
    const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
    
    if (purePhone.length < 8) return null;
    
    // Mutex Local
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        // 1. Verifica existência usando Phone puro
        const { data: existing } = await supabase.from('leads')
            .select('id, name')
            .eq('phone', purePhone)
            .eq('company_id', companyId)
            .maybeSingle();

        const nameIsValid = !isGenericName(pushName, purePhone);
        
        if (existing) {
            // Self-Healing: Se chegou um nome válido e o atual é NULL/Ruim, atualiza
            if (nameIsValid && (!existing.name || isGenericName(existing.name, purePhone))) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 2. Se não existe, cria novo
        // REGRA DE OURO: Se não tem nome válido, vai como NULL.
        // O Frontend mostrará o telefone formatado, mas o banco fica limpo.
        let finalName = nameIsValid ? pushName : null;
        
        // Tenta buscar backup na tabela de contatos se o nome atual for ruim
        if (!finalName) {
            const { data: contact } = await supabase.from('contacts').select('name, push_name').eq('jid', cleanJid).eq('company_id', companyId).maybeSingle();
            if (contact) {
                if (!isGenericName(contact.name, purePhone)) finalName = contact.name;
                else if (!isGenericName(contact.push_name, purePhone)) finalName = contact.push_name;
            }
        }

        // Pega o primeiro estágio do funil
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: purePhone,
            name: finalName, // AQUI: NULL SE NÃO TIVER NOME
            status: 'new',
            pipeline_stage_id: stage?.id
        }).select('id').single();

        return newLead?.id;
    } catch (e) {
        return null;
    } finally {
        setTimeout(() => leadLock.delete(lockKey), 1000);
    }
};

export const upsertMessage = async (msgData) => {
    try {
        // Delay para garantir integridade referencial
        await new Promise(resolve => setTimeout(resolve, 200));
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        
        const finalData = {
            ...msgData,
            remote_jid: cleanRemoteJid
        };

        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
    } catch (e) {}
};

// Funções utilitárias adicionais
export const savePollVote = async (msg, companyId) => {};
export const deleteSessionData = async (sessionId) => {
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};
export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
