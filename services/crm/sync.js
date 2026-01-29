
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const leadLock = new Set(); 

// --- HELPERS ---

export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid;
    if (jid.includes('@newsletter')) return jid;
    return jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
};

// Valida se o nome é "lixo" (número puro, vazio ou undefined)
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    
    // Se o nome for igual ao telefone (com ou sem formatação)
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;
    
    // Deve conter pelo menos uma letra para ser considerado nome real
    return !/[a-zA-Z\u00C0-\u00FF]/.test(cleanName);
};

// --- CORE SYNC FUNCTIONS ---

export const updateInstanceStatus = async (sessionId, companyId, data) => {
    await supabase.from('instances')
        .update({ ...data, updated_at: new Date() })
        .eq('session_id', sessionId)
        .eq('company_id', companyId);
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {
        console.error(`❌ [SYNC] Erro status:`, e.message);
    }
};

/**
 * UPSERT CONTACT MASTER (Regras Estritas de Hierarquia)
 * @param {string} jid 
 * @param {string} companyId 
 * @param {string} incomingName - Nome vindo do evento (pode ser da agenda ou pushname)
 * @param {string} profilePicUrl 
 * @param {boolean} isFromBook - VEIO DA AGENDA DO CELULAR? (Alta Prioridade)
 * @param {string} lid 
 * @param {boolean} isBusiness - É conta comercial?
 * @param {string} verifiedName - Nome verificado da API Business
 */
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false, lid = null, isBusiness = false, verifiedName = null) => {
    try {
        if (!jid || !companyId) return;
        if (jid.includes('status@broadcast')) return;

        const cleanJid = normalizeJid(jid);
        const purePhone = cleanJid.split('@')[0].replace(/\D/g, ''); 
        
        // Dados Base
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date()
        };

        if (isBusiness) updateData.is_business = true;
        if (verifiedName) updateData.verified_name = verifiedName;

        // --- HIERARQUIA DE NOMES (REGRA DE OURO) ---
        // 1. Agenda (isFromBook) -> Salva em 'name'
        // 2. Business Verified -> Salva em 'verified_name'
        // 3. PushName -> Salva em 'push_name'
        
        const incomingNameValid = !isGenericName(incomingName, purePhone);

        if (isFromBook && incomingNameValid) {
            // Se veio da agenda, sobrescreve 'name' (Autoridade Máxima)
            updateData.name = incomingName;
        } else if (incomingNameValid) {
            // Se não é da agenda mas é um nome válido, assumimos que é PushName
            updateData.push_name = incomingName;
            
            // Só promove para 'name' se ele estiver vazio no banco?
            // NÃO. O banco decide na hora de ler (View/RPC) qual mostrar.
            // Aqui apenas salvamos no campo correto.
        }

        // --- FOTO DE PERFIL ---
        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
            updateData.profile_pic_updated_at = new Date(); 
        }

        // Executa Upsert
        // No Supabase, se um campo não for passado no updateData durante um conflito, 
        // ele NÃO é alterado (comportamento padrão do Postgres UPSERT DO UPDATE SET...).
        // Mas o supabase-js envia apenas o que passamos.
        // Se isFromBook=false, NÃO enviamos 'name' para evitar apagar um nome de agenda existente com NULL.
        
        if (!isFromBook && !updateData.name) {
            delete updateData.name;
        }

        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });
        if (error) throw error;

        // Vínculo LID (Identidade Oculta)
        if (lid) {
            supabase.rpc('link_identities', { 
                p_lid: normalizeJid(lid), 
                p_phone: cleanJid, 
                p_company_id: companyId 
            }).then(() => {});
        }

        // --- ATUALIZAÇÃO DO LEAD EM TEMPO REAL ---
        // Se o nome do contato mudou (e é um nome bom), atualiza o lead correspondente se ele estiver sem nome
        if (!cleanJid.includes('@g.us') && !cleanJid.includes('@newsletter')) {
            const bestNameAvailable = isFromBook ? incomingName : (verifiedName || incomingName);
            
            if (bestNameAvailable && !isGenericName(bestNameAvailable, purePhone)) {
                const { data: lead } = await supabase.from('leads')
                    .select('id, name')
                    .eq('company_id', companyId)
                    .eq('phone', purePhone)
                    .maybeSingle();
                
                // Se o lead existe e tem nome genérico, atualiza
                if (lead && isGenericName(lead.name, purePhone)) {
                    await supabase.from('leads').update({ name: bestNameAvailable }).eq('id', lead.id);
                }
            }
        }

    } catch (e) {
        console.error(`❌ [SYNC] Erro upsertContact:`, e.message);
    }
};

/**
 * GARANTIA DE LEAD (Filtros Rigorosos)
 * Só cria se: Não for Grupo, Não for Canal, Não for EU.
 */
export const ensureLeadExists = async (jid, companyId, pushName, myJid) => {
    // 1. FILTROS DE EXCLUSÃO (REGRA DO CLIENTE)
    if (!jid) return null;
    if (jid.includes('@g.us')) return null; // Grupos OFF
    if (jid.includes('@newsletter')) return null; // Canais OFF
    if (jid.includes('status@broadcast')) return null;
    
    const cleanJid = normalizeJid(jid);
    const cleanMyJid = normalizeJid(myJid);

    // Filtra o próprio número conectado
    if (cleanMyJid && cleanJid === cleanMyJid) return null;

    const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
    if (purePhone.length < 8) return null;
    
    // Lock para evitar race condition
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        // 2. Busca Lead Existente
        const { data: existing } = await supabase.from('leads')
            .select('id, name')
            .eq('phone', purePhone)
            .eq('company_id', companyId)
            .maybeSingle();

        if (existing) return existing.id;

        // 3. Busca Dados Enriquecidos (Agenda/Business) do Contato
        // Isso garante que se já baixamos a agenda, o lead nasce com o nome certo
        const { data: contact } = await supabase.from('contacts')
            .select('name, push_name, verified_name')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        // 4. Determina Melhor Nome para o Lead
        let finalName = null;
        if (contact) {
            // Prioridade: Agenda > Business > PushName
            if (!isGenericName(contact.name, purePhone)) finalName = contact.name;
            else if (!isGenericName(contact.verified_name, purePhone)) finalName = contact.verified_name;
            else if (!isGenericName(contact.push_name, purePhone)) finalName = contact.push_name;
        }

        // Fallback: Nome que veio na mensagem atual (pushName do evento)
        if (!finalName && pushName && !isGenericName(pushName, purePhone)) {
            finalName = pushName;
        }

        // Se ainda for nulo, MANTÉM NULL conforme solicitado (o front formata o telefone)

        // 5. Pega Funil Padrão
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        // 6. Criação do Lead
        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: purePhone,
            name: finalName, // Pode ser NULL
            status: 'new',
            pipeline_stage_id: stage?.id,
            position: Date.now()
        }).select('id').single();

        return newLead?.id;

    } catch (e) {
        console.error(`❌ [SYNC] Erro ensureLead:`, e.message);
        return null;
    } finally {
        setTimeout(() => leadLock.delete(lockKey), 2000);
    }
};

export const upsertMessage = async (msgData) => {
    try {
        // Pequeno delay para garantir que o ensureLead rodou (Integridade FK se houvesse, mas é bom para ordem lógica)
        await new Promise(resolve => setTimeout(resolve, 150));
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        
        const finalData = {
            ...msgData,
            remote_jid: cleanRemoteJid
        };

        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
        
    } catch (e) {
        console.error(`❌ [SYNC] Erro upsertMessage:`, e.message);
    }
};

export const updateCampaignStats = async (campaignId, status) => {
    try {
        await supabase.rpc('increment_campaign_count', { 
            p_campaign_id: campaignId, 
            p_field: status 
        });
    } catch (e) {}
};

export const deleteSessionData = async (sessionId, companyId) => {
    await supabase.from('instances')
        .update({ status: 'disconnected', qrcode_url: null })
        .eq('session_id', sessionId)
        .eq('company_id', companyId);
        
    await supabase.from('baileys_auth_state')
        .delete()
        .eq('session_id', sessionId);
};
