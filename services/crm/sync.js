
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

const leadLock = new Set(); 

// --- NAME SANITIZER BLINDADO V5 ---
// Retorna TRUE se o nome for lixo (número puro, undefined, null, só símbolos)
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.toString().trim();
    if (cleanName.length === 0) return true;
    
    // Se o nome for apenas caracteres não alfabéticos (ex: "+55 11...", "---", "1234")
    // Permite letras, acentos e emojis. Rejeita se só tiver números e pontuação.
    if (/^[\d\s\+\-\(\)\.]+$/.test(cleanName)) return true;
    
    // Comparação direta com o telefone
    const cleanPhone = phone.replace(/\D/g, '');
    const cleanNameDigits = cleanName.replace(/\D/g, '');
    
    if (cleanNameDigits === cleanPhone) return true; // É o próprio número
    
    return false;
};

export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ sync_status: status, sync_percent: percent, updated_at: new Date() })
            .eq('session_id', sessionId);
    } catch (e) {}
};

// PATCH: Adicionado parâmetro `isFromBook` (Prioridade Alta)
export const upsertContact = async (jid, companyId, incomingName = null, profilePicUrl = null, isFromBook = false) => {
    try {
        if (!jid || !companyId) return;

        const isGroup = jid.includes('@g.us');
        // Normaliza JID (remove dispositivo :2, etc)
        const cleanJid = jid.split('@')[0].split(':')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
        const phone = cleanJid.split('@')[0];
        
        // 1. Busca dados atuais (Leitura leve)
        const { data: current } = await supabase
            .from('contacts')
            .select('name, push_name, profile_pic_url')
            .eq('jid', cleanJid)
            .eq('company_id', companyId)
            .maybeSingle();

        const updateData = {
            jid: cleanJid,
            phone: phone,
            company_id: companyId,
            updated_at: new Date(),
            last_message_at: new Date() // Mantém o contato "vivo"
        };

        // --- LÓGICA DE PRIORIDADE (NAME HUNTER V5 + AUTHORITY) ---
        let finalName = null;
        let shouldUpdateLead = false;
        
        // O nome que chegou é válido?
        const incomingIsGood = !isGenericName(incomingName, phone);
        // O nome que já temos no banco é válido?
        const currentIsGood = current && !isGenericName(current.name, phone);

        if (incomingIsGood) {
            // Sempre salvamos o push_name se vier algo bom para histórico/debug
            updateData.push_name = incomingName; 

            // DECISÃO DE ATUALIZAÇÃO DO NOME PRINCIPAL (Display Name)
            // 1. Se o banco está vazio ou tem nome ruim -> ATUALIZA SEMPRE.
            // 2. Se a origem é a AGENDA (isFromBook) -> FORCE UPDATE (O usuário mandou).
            // 3. Se não é da agenda (PushName), SÓ atualiza se o banco estiver ruim.
            
            const shouldOverwrite = !currentIsGood || isFromBook;

            if (shouldOverwrite) {
                // Só dispara update se o nome for realmente diferente
                if (!current || current.name !== incomingName) {
                    updateData.name = incomingName;
                    finalName = incomingName;
                    shouldUpdateLead = true;
                }
            } 
        } else {
            // Se o que chegou é ruim (null ou número), mas não temos nada no banco
            // Forçamos NULL para evitar salvar o número como nome (regra do sanitizer)
            if (!current && !currentIsGood) {
                updateData.name = null;
            }
        }

        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
        }

        // Executa UPSERT
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        if (error) {
             console.error('[CONTACT SYNC ERROR]', error.message);
        } else if (shouldUpdateLead && finalName && !isGroup) {
            // [PROPAGAÇÃO PARA LEADS]
            // Atualiza o Lead se o contato mudou de nome
            
            // 1. Busca Lead Existente
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .ilike('phone', `%${phone}%`)
                .limit(1)
                .maybeSingle();

            // 2. Regra de Atualização do Lead:
            // - Se o Lead tem nome ruim (Número) -> Atualiza.
            // - Se veio da Agenda (isFromBook) -> Atualiza (Sincronia total Agenda -> CRM).
            if (lead) {
                if (isGenericName(lead.name, phone) || isFromBook) {
                    await supabase.from('leads').update({ name: finalName }).eq('id', lead.id);
                }
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

export const ensureLeadExists = async (jid, companyId, pushName) => {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) return null; 

    const phone = jid.split('@')[0].split(':')[0]; // Clean phone
    if (!/^\d+$/.test(phone)) return null;
    
    const lockKey = `${companyId}:${phone}`;
    if (leadLock.has(lockKey)) return null;
    
    try {
        leadLock.add(lockKey);

        const { data: existing } = await supabase.from('leads').select('id, name').eq('phone', phone).eq('company_id', companyId).maybeSingle();

        if (existing) {
            // Atualiza nome do lead existente se ele não tiver nome bom e o novo for bom
            if (pushName && !isGenericName(pushName, phone) && isGenericName(existing.name, phone)) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // [NOVO LEAD]
        // Se tem nome válido, usa. Se não, usa NULL (deixa o frontend lidar ou futura atualização)
        const nameToUse = (pushName && !isGenericName(pushName, phone)) ? pushName : null;
        
        const { data: stage } = await supabase.from('pipeline_stages').select('id').eq('company_id', companyId).order('position', { ascending: true }).limit(1).maybeSingle();

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: phone,
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
        // Pequeno delay para garantir que o contato foi criado antes da mensagem
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
