
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase com Service Role (Ignora RLS no lado do Node)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Mutex para evitar criação duplicada de leads em rajadas de mensagens
const leadLock = new Set(); 

// --- NAME SANITIZER V6.1 ---
// Retorna TRUE se o nome for inválido (apenas números, simbolos, nulo ou curto demais)
const isGenericName = (name) => {
    if (!name) return true;
    const clean = String(name).trim();
    if (clean.length < 1) return true;
    
    // Regex: Deve conter pelo menos uma letra (latinas ou acentuadas)
    // Isso bloqueia nomes como "+55 11...", "12345", "..."
    const hasLetters = /[a-zA-Z\u00C0-\u00FF]/.test(clean);
    return !hasLetters; 
};

// Atualiza o status visual da instância no frontend
export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {
        // Ignora erros de update de status para não parar o fluxo
    }
};

// PATCH: Sincronização Robusta (Contact -> Lead)
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false) => {
    try {
        if (!jid || !companyId) return;

        const isGroup = jid.includes('@g.us');
        // Normaliza JID (Remove sufixos de device :2, :99)
        const cleanJid = jid.split('@')[0].split(':')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
        
        // EXTRAÇÃO DE TELEFONE PURO (A Chave Mestra)
        const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
        
        // 1. Prepara dados para UPSERT no CONTACTS
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date(),
            last_message_at: new Date()
        };

        // 2. Lógica de Higiene de Nomes (Name Hunter)
        const incomingIsGood = !isGenericName(incomingName);

        if (incomingIsGood) {
            updateData.push_name = incomingName;
            // Se veio da Agenda (isFromBook), forçamos o nome
            if (isFromBook) {
                updateData.name = incomingName;
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // 3. Executa UPSERT no CONTACTS
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // 4. AUTO-HEALING DE LEADS (Correção de NULLs)
        // Se o contato foi salvo e temos um nome bom, garantimos que o Lead também tenha esse nome
        if (!error && incomingIsGood && !isGroup) {
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone)
                .limit(1)
                .maybeSingle();

            if (lead) {
                // SÓ ATUALIZA SE:
                // 1. O nome atual do lead for NULL
                // 2. OU O nome atual for genérico (número)
                // 3. OU A fonte for autoritativa (Agenda) e o nome for diferente
                const currentNameBad = !lead.name || isGenericName(lead.name);
                
                if (currentNameBad || (isFromBook && lead.name !== incomingName)) {
                    await supabase.from('leads')
                        .update({ name: incomingName })
                        .eq('id', lead.id);
                }
            }
        }

    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

// Garante que o Lead exista quando chega uma mensagem
export const ensureLeadExists = async (jid, companyId, pushName) => {
    // Ignora grupos e status
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    // Pure Phone para busca segura
    const purePhone = jid.split('@')[0].replace(/\D/g, '');
    if (purePhone.length < 8) return null;
    
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

        // 2. SE EXISTE: Verifica se precisa de Auto-Fix no nome (Self-Healing)
        if (existing) {
            // Se o lead tem nome ruim/NULL e chegou um nome bom, corrige AGORA.
            if (!isGenericName(pushName) && (isGenericName(existing.name) || !existing.name)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 3. SE NÃO EXISTE: Cria novo Lead
        const nameToUse = (!isGenericName(pushName)) ? pushName : null; 
        
        // Pega primeiro estágio do funil
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: purePhone, // Salva apenas números
            name: nameToUse,
            status: 'new',
            pipeline_stage_id: stage?.id
        }).select('id').single();

        return newLead?.id;
    } catch (e) {
        // logger.error({ err: e.message }, 'Erro ensureLeadExists');
        return null;
    } finally {
        leadLock.delete(lockKey);
    }
};

// Salva a mensagem no banco
export const upsertMessage = async (msgData) => {
    try {
        // Delay tático (200ms) para permitir que 'ensureLeadExists' ou 'upsertContact'
        // terminem suas transações antes de salvar a mensagem, evitando FK errors.
        await new Promise(resolve => setTimeout(resolve, 200));
        
        const { error } = await supabase.from('messages').upsert(msgData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
    } catch (e) {
        // logger.error({ err: e.message }, 'Erro upsertMessage');
    }
};

// Funções Auxiliares (Mantidas para compatibilidade total)
export const savePollVote = async (msg, companyId) => {
    // Implementação futura de votos
};

export const deleteSessionData = async (sessionId) => {
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};

export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
