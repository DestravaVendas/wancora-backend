
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase com Service Role (Ignora RLS para o Backend)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Mutex para evitar Race Conditions na criação de Leads em rajadas
const leadLock = new Set(); 

// --- HELPER: NAME VALIDATION ---
// Detecta se uma string é provavelmente um número de telefone e não um nome real
const isPhoneNumber = (name) => {
    if (!name) return true;
    // Remove tudo que não é letra
    const letters = name.replace(/[^a-zA-Z]/g, '');
    // Se tiver menos de 1 letra, consideramos que é um número ou símbolo
    return letters.length < 1; 
};

// Formata telefone para exibição visual bonita caso não tenha nome
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

// --- SYNC CONTACTS (AGENDA & METADADOS) ---
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false) => {
    try {
        if (!jid || !companyId) return;
        if (jid.includes('status@broadcast')) return;

        const isGroup = jid.includes('@g.us');
        // Normaliza JID para evitar duplicatas (ex: remove :12@...) e lida com LID se necessário
        const cleanJid = jid.split('@')[0].split(':')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
        const purePhone = jid.split('@')[0].replace(/\D/g, ''); 
        
        // 1. Prepara dados do contato para tabela 'contacts'
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date()
        };

        // Lógica de Prioridade de Nome:
        // Se vier da agenda (isFromBook), salvamos em 'name'.
        // Se vier do perfil (PushName), salvamos em 'push_name'.
        if (incomingName && !isPhoneNumber(incomingName)) {
            if (isFromBook) updateData.name = incomingName; 
            else updateData.push_name = incomingName;       
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // 2. Upsert na tabela contacts (Agenda)
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        // 3. LEAD SELF-HEALING (A Mágica da Atualização)
        // Se o contato virou Lead, verificamos se precisamos melhorar o nome dele
        if (!error && !isGroup) {
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone)
                .limit(1)
                .maybeSingle();

            if (lead) {
                // Se o lead existe, verificamos se o nome atual é "ruim" (parece número)
                const currentNameIsBad = !lead.name || isPhoneNumber(lead.name);
                const newNameIsGood = incomingName && !isPhoneNumber(incomingName);

                // Se temos um nome novo BOM e o atual é RUIM (ou se veio explicitamente da agenda), atualizamos
                if (newNameIsGood && (currentNameIsBad || isFromBook)) {
                    // console.log(`[SYNC] Corrigindo nome do Lead ${purePhone}: ${lead.name} -> ${incomingName}`);
                    await supabase.from('leads').update({ name: incomingName }).eq('id', lead.id);
                }
            } else if (isFromBook && incomingName && !isPhoneNumber(incomingName)) {
                // Opcional: Auto-criar leads da agenda. 
                // Mantido comentado para não poluir o CRM com contatos que nunca conversaram.
                /*
                const { data: stage } = await supabase.from('pipeline_stages').select('id').eq('company_id', companyId).order('position').limit(1).single();
                await supabase.from('leads').insert({
                    company_id: companyId,
                    phone: purePhone,
                    name: incomingName,
                    status: 'new',
                    pipeline_stage_id: stage?.id
                });
                */
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

// --- GARANTIA DE LEAD (Criação ou Busca) ---
export const ensureLeadExists = async (jid, companyId, pushName) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    const purePhone = jid.split('@')[0].replace(/\D/g, '');
    if (purePhone.length < 8) return null;
    
    // Mutex Local para evitar criação duplicada em rajadas simultâneas
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        // 1. Verifica existência
        const { data: existing } = await supabase.from('leads')
            .select('id, name')
            .eq('phone', purePhone)
            .eq('company_id', companyId)
            .maybeSingle();

        const nameIsValid = pushName && !isPhoneNumber(pushName);
        
        if (existing) {
            // Self-Healing no momento da mensagem: Atualiza se o nome no banco for número e agora temos nome real
            if (nameIsValid && isPhoneNumber(existing.name)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 2. Se não existe, cria novo
        // Tenta buscar nome na tabela de contatos antes (pode ter vindo da agenda anteriormente)
        let finalName = nameIsValid ? pushName : formatPhoneAsName(purePhone);
        
        if (!nameIsValid) {
            const { data: contact } = await supabase.from('contacts').select('name, push_name').eq('jid', jid).eq('company_id', companyId).maybeSingle();
            if (contact?.name) finalName = contact.name;
            else if (contact?.push_name) finalName = contact.push_name;
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
            name: finalName, 
            status: 'new',
            pipeline_stage_id: stage?.id
        }).select('id').single();

        return newLead?.id;
    } catch (e) {
        return null;
    } finally {
        // Libera o lock após 1 segundo para garantir propagação no banco
        setTimeout(() => leadLock.delete(lockKey), 1000);
    }
};

export const upsertMessage = async (msgData) => {
    try {
        // Pequeno delay para garantir que Contact/Lead existam antes da mensagem (FK safety)
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Upsert ignorando conflitos (deduplicação via banco key remote_jid + whatsapp_id)
        const { error } = await supabase.from('messages').upsert(msgData, { onConflict: 'remote_jid, whatsapp_id' });
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
