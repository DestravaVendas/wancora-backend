
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// --- AMBIENTE DE TESTE ---
// Inicializa o cliente Supabase com Service Role
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'debug' }); // Nível debug para ver tudo

// Mutex para evitar Race Conditions (Mantido da versão Production)
const leadLock = new Set(); 

// --- HELPER: NAME VALIDATION (Name Hunter V5) ---
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length < 1) return true;
    
    // Se o nome for igual ao telefone
    if (phone && cleanName.replace(/\D/g, '') === phone.replace(/\D/g, '')) return true;

    // Deve conter letras
    const hasLetters = /[a-zA-Z\u00C0-\u00FF]/.test(cleanName);
    return !hasLetters; 
};

// --- HELPER: JID NORMALIZATION (Core Logic) ---
export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid.split('@')[0] + '@g.us';
    const user = jid.split('@')[0].split(':')[0];
    return `${user}@s.whatsapp.net`;
};

const formatPhoneAsName = (phone) => {
    if (!phone) return "Desconhecido";
    const p = phone.replace(/\D/g, '');
    if (p.length >= 12 && p.startsWith('55')) {
        const ddd = p.substring(2, 4);
        const num = p.substring(4);
        return `+55 (${ddd}) ${num.substring(0, 5)}-${num.substring(5)}`;
    }
    return `+${p}`;
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        console.log(`🔄 [TEST-SYNC] Status Update: ${status} (${percent}%)`);
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {
        console.error(`❌ [TEST-SYNC] Erro ao atualizar status:`, e.message);
    }
};

// --- SYNC CONTACTS (COM LOGS DETALHADOS) ---
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false) => {
    try {
        if (!jid || !companyId) return;
        if (jid.includes('status@broadcast')) return;

        // 1. Normalização
        const cleanJid = normalizeJid(jid);
        const isGroup = cleanJid.includes('@g.us');
        const purePhone = cleanJid.split('@')[0].replace(/\D/g, ''); 
        
        console.log(`🔍 [TEST-SYNC] Upsert Contact | Original: ${jid} | Clean: ${cleanJid} | Name: "${incomingName}" | FromBook: ${isFromBook}`);

        // 2. Preparação
        const updateData = {
            jid: cleanJid,
            phone: purePhone, 
            company_id: companyId,
            updated_at: new Date()
        };

        // 3. Validação de Nome (Name Hunter)
        const nameIsValid = !isGenericName(incomingName, purePhone);

        if (nameIsValid) {
            updateData.push_name = incomingName;
            // Se veio da Agenda, força o nome
            if (isFromBook) {
                console.log(`✅ [TEST-SYNC] Nome da Agenda detectado. Forçando autoridade: "${incomingName}"`);
                updateData.name = incomingName;
            } else {
                console.log(`ℹ️ [TEST-SYNC] Nome via PushName. Salvando apenas em push_name.`);
            }
        } else {
            console.warn(`⚠️ [TEST-SYNC] Nome ignorado (Genérico/Inválido): "${incomingName}"`);
        }

        if (profilePicUrl) updateData.profile_pic_url = profilePicUrl;

        // 4. Upsert Tabela Contacts
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });
        
        if (error) {
            console.error(`❌ [TEST-SYNC] Erro no Upsert Contacts:`, error.message);
            return;
        }

        // 5. LEAD SELF-HEALING (A Cura)
        if (!isGroup && nameIsValid) {
            // Busca Lead existente
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', purePhone)
                .limit(1)
                .maybeSingle();

            if (lead) {
                const currentNameIsBad = isGenericName(lead.name, purePhone);
                console.log(`🏥 [TEST-SYNC] Analisando Lead ${lead.id}. Nome atual: "${lead.name}". É ruim? ${currentNameIsBad}`);

                if (currentNameIsBad || isFromBook) {
                    console.log(`💉 [TEST-SYNC] Aplicando correção de nome no Lead: "${lead.name}" -> "${incomingName}"`);
                    await supabase.from('leads').update({ name: incomingName }).eq('id', lead.id);
                }
            } else if (isFromBook) {
                console.log(`✨ [TEST-SYNC] Lead não existe, mas veio da Agenda. Criando automaticamente...`);
                await ensureLeadExists(cleanJid, companyId, incomingName);
            }
        }

    } catch (e) {
        console.error(`🔥 [TEST-SYNC] CRITICAL ERROR em upsertContact:`, e);
    }
};

// --- ENSURE LEAD (COM MUTEX & LOGS) ---
export const ensureLeadExists = async (jid, companyId, pushName) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    const cleanJid = normalizeJid(jid);
    const purePhone = cleanJid.split('@')[0].replace(/\D/g, '');
    
    if (purePhone.length < 8) return null;
    
    const lockKey = `${companyId}:${purePhone}`;
    if (leadLock.has(lockKey)) {
        console.warn(`🔒 [TEST-SYNC] Race Condition evitada para ${purePhone}.`);
        return null;
    }
    
    try {
        leadLock.add(lockKey);
        console.log(`🔐 [TEST-SYNC] Lock adquirido para Lead: ${purePhone}`);

        // 1. Verifica existência
        const { data: existing } = await supabase.from('leads')
            .select('id, name')
            .eq('phone', purePhone)
            .eq('company_id', companyId)
            .maybeSingle();

        const nameIsValid = !isGenericName(pushName, purePhone);
        
        if (existing) {
            console.log(`exists [TEST-SYNC] Lead já existe: ${existing.id}`);
            // Self-Healing
            if (nameIsValid && isGenericName(existing.name, purePhone)) {
                console.log(`🛠 [TEST-SYNC] Atualizando nome genérico do Lead existente.`);
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // 2. Preparação do Novo Lead
        let finalName = nameIsValid ? pushName : formatPhoneAsName(purePhone);
        
        // Tentativa de resgate do nome na tabela de contatos
        if (isGenericName(finalName, purePhone)) {
            console.log(`🔎 [TEST-SYNC] Nome ainda é ruim. Buscando backup na tabela contacts...`);
            const { data: contact } = await supabase.from('contacts').select('name, push_name').eq('jid', cleanJid).eq('company_id', companyId).maybeSingle();
            if (contact) {
                if (!isGenericName(contact.name, purePhone)) finalName = contact.name;
                else if (!isGenericName(contact.push_name, purePhone)) finalName = contact.push_name;
            }
        }

        // Pega Funil
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        console.log(`🆕 [TEST-SYNC] Inserindo NOVO Lead: ${finalName} (${purePhone})`);

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: purePhone,
            name: finalName, 
            status: 'new',
            pipeline_stage_id: stage?.id
        }).select('id').single();

        return newLead?.id;

    } catch (e) {
        console.error(`🔥 [TEST-SYNC] Erro ao criar Lead:`, e);
        return null;
    } finally {
        setTimeout(() => {
            leadLock.delete(lockKey);
            // console.log(`🔓 [TEST-SYNC] Lock liberado.`);
        }, 1000);
    }
};

// --- UPSERT MESSAGE (COM DELAY TÁTICO) ---
export const upsertMessage = async (msgData) => {
    try {
        // Delay para garantir integridade referencial (FK)
        await new Promise(resolve => setTimeout(resolve, 150));
        
        const cleanRemoteJid = normalizeJid(msgData.remote_jid);
        console.log(`📨 [TEST-SYNC] Salvando mensagem de ${cleanRemoteJid} (Type: ${msgData.message_type})`);
        
        const finalData = {
            ...msgData,
            remote_jid: cleanRemoteJid
        };

        const { error } = await supabase.from('messages').upsert(finalData, { onConflict: 'remote_jid, whatsapp_id' });
        if (error) throw error;
        
    } catch (e) {
        console.error(`❌ [TEST-SYNC] Erro ao salvar mensagem:`, e.message);
    }
};

// Funções utilitárias (Mantidas para compatibilidade)
export const savePollVote = async (msg, companyId) => { console.log(`🗳️ [TEST-SYNC] Voto registrado.`); };
export const deleteSessionData = async (sessionId) => {
    console.log(`🗑️ [TEST-SYNC] Deletando sessão: ${sessionId}`);
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};
export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
