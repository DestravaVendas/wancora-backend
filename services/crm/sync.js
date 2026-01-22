
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase com Service Role (Ignora RLS no lado do Node)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Mutex para evitar criação duplicada de leads em rajadas de mensagens
const leadLock = new Set(); 

// --- NAME SANITIZER V5.5 ---
// Retorna TRUE se o nome for inválido (apenas números, simbolos, nulo ou curto demais)
const isGenericName = (name) => {
    if (!name) return true;
    const clean = name.toString().trim();
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
        // Remove tudo que não for dígito. Essencial para match com a tabela 'leads'.
        const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
        
        // 1. Prepara dados para UPSERT no CONTACTS
        const updateData = {
            jid: cleanJid,
            phone: purePhone, // Persiste o número limpo para facilitar buscas futuras
            company_id: companyId,
            updated_at: new Date(),
            last_message_at: new Date()
        };

        // 2. Lógica de Higiene de Nomes (Name Hunter)
        const incomingIsGood = !isGenericName(incomingName);

        if (incomingIsGood) {
            // Sempre salvamos o push_name se ele for válido
            updateData.push_name = incomingName;
            
            // DECISÃO DE AUTORIDADE PARA O CAMPO 'NAME':
            // Se veio da Agenda (isFromBook), é a verdade absoluta.
            // Se não, deixamos o banco decidir (via ON CONFLICT ou Trigger), 
            // mas se formos forçar, seria apenas se o banco estivesse vazio.
            if (isFromBook) {
                updateData.name = incomingName;
            }
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // 3. Executa UPSERT no CONTACTS
        // O Trigger SQL `trg_auto_sync_lead_name` deve estar ativo no banco para propagar isso para leads.
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // 4. FAIL-SAFE: Atualização Manual de Leads (Caso Trigger falhe ou Race Condition)
        // Se temos um nome de alta confiança (Agenda), forçamos a atualização no Lead também.
        if (!error && incomingIsGood && isFromBook && !isGroup) {
            // Busca Lead pelo Pure Phone (Match Matemático)
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone)
                .limit(1)
                .maybeSingle();

            if (lead) {
                // Só atualiza se o nome atual for ruim ou diferente da agenda
                if (isGenericName(lead.name) || lead.name !== incomingName) {
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
    
    // Mutex: Evita criar 2 leads se chegarem 10 mensagens em 1 segundo
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        // 1. Verifica existência usando Phone puro
        const { data: existing } = await supabase.from('leads')
            .select('id, name')
            .eq('phone', purePhone)
            .eq('company_id', companyId)
            .maybeSingle();

        // 2. Se existe, verifica se precisa de Auto-Fix no nome (Self-Healing)
        if (existing) {
            if (pushName && !isGenericName(pushName) && isGenericName(existing.name)) {
                // Se o lead tem nome ruim ("5511...") e chegou um nome bom ("João"), corrige.
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 3. Se não existe, cria novo Lead
        const nameToUse = (pushName && !isGenericName(pushName)) ? pushName : null; // Cria como NULL se não tiver nome bom
        
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
