
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase
// Garante que usa as variáveis de ambiente carregadas no server.js
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

const leadLock = new Set(); // Mutex para evitar duplicidade na criação de leads

/**
 * Atualiza o status da sincronização na tabela 'instances'
 */
export const updateSyncStatus = async (sessionId, status, percent = 0) => {
    try {
        await supabase.from('instances')
            .update({ 
                sync_status: status, 
                sync_percent: percent,
                updated_at: new Date()
            })
            .eq('session_id', sessionId);
    } catch (e) {}
};

/**
 * Verifica se um nome é estritamente o número de telefone.
 * Usado para evitar salvar o número no campo "nome" do banco de dados.
 */
const isStrictlyPhoneNumber = (name, phone) => {
    if (!name) return true;
    const cleanName = name.replace(/[^0-9]/g, '');
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Se o nome limpo for igual ao telefone, ou se o nome for apenas "+55...", é inválido.
    return cleanName === cleanPhone || name.replace(/[^0-9+]/g, '') === `+${cleanPhone}`;
};

/**
 * Upsert Inteligente de Contato (RESTAURADO)
 */
export const upsertContact = async (jid, companyId, pushName = null, profilePicUrl = null) => {
    try {
        if (!jid || !companyId) return;
        
        const isGroup = jid.includes('@g.us');
        const cleanJid = jid.split('@')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
        const phone = cleanJid.split('@')[0];
        
        const updateData = {
            jid: cleanJid,
            phone: phone, 
            company_id: companyId,
            updated_at: new Date(),
            last_message_at: new Date()
        };

        // --- LÓGICA DE NOME (SIMPLIFICADA PARA FUNCIONAR) ---
        // Se recebermos um nome, salvamos.
        // A única exceção é se o nome for literalmente igual ao número de telefone.
        if (pushName && pushName.trim().length > 0) {
            // Salva no push_name sempre (histórico de identidade)
            updateData.push_name = pushName;

            if (!isStrictlyPhoneNumber(pushName, phone)) {
                updateData.name = pushName;
            }
        }

        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
        }

        // Realiza o Upsert no Contato
        // Usamos upsert simples. Se o nome vier null, o Supabase ignora se configurado para ignoreDuplicates (mas aqui queremos update)
        // Se updateData.name não estiver definido, o upsert não deve apagar o nome existente (comportamento padrão do spread se usássemos patch, mas upsert substitui)
        // Então precisamos buscar o atual se quisermos ser muito cuidadosos, mas para performance vamos confiar no fluxo:
        // Se pushName veio, é o dado mais recente.
        
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        if (error) {
            console.error('[CONTACT SYNC ERROR]', error.message);
        } else if (updateData.name && !isGroup) {
            // --- PROPAGAÇÃO PARA LEADS ---
            // Se salvamos um nome válido, atualizamos o Lead
            await supabase.from('leads')
                .update({ name: updateData.name })
                .eq('company_id', companyId)
                .eq('phone', phone)
                .like('name', '+%'); // Só substitui no Lead se o Lead estiver com nome de número (+55...)
        }

    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

/**
 * Garante que o Lead existe na tabela 'leads' (Anti-Ghost)
 */
export const ensureLeadExists = async (jid, companyId, pushName) => {
    // BLINDAGEM CONTRA GRUPOS
    if (!jid || jid.endsWith('@g.us') || jid.includes('-') || jid.includes('status@broadcast')) {
        return null; 
    }

    const phone = jid.split('@')[0];
    
    // Validação extra: Se o "phone" não parecer um número, aborta
    if (!/^\d+$/.test(phone)) return null;

    const lockKey = `${companyId}:${phone}`;
    if (leadLock.has(lockKey)) return null;

    try {
        leadLock.add(lockKey);

        const { data: existing } = await supabase
            .from('leads')
            .select('id, name')
            .eq('phone', phone)
            .eq('company_id', companyId)
            .maybeSingle();

        if (existing) {
            // Se já existe e temos um nome novo (e o atual é número), atualiza
            if (pushName && !isStrictlyPhoneNumber(pushName, phone) && existing.name.startsWith('+')) {
                await supabase.from('leads').update({ name: pushName }).eq('id', existing.id);
            }
            return existing.id;
        }

        // Se não existe, cria
        // PRIORIDADE: Nome Real > Número Formatado (+55...)
        // Nunca mais usa "Lead XXXX"
        let nameToUse = `+${phone}`;
        if (pushName && !isStrictlyPhoneNumber(pushName, phone)) {
            nameToUse = pushName;
        }
        
        const { data: stage } = await supabase
            .from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            phone: phone,
            name: nameToUse,
            status: 'new',
            pipeline_stage_id: stage?.id
        }).select('id').single();

        return newLead?.id;

    } catch (e) {
        logger.error({ err: e.message }, 'Erro ensureLeadExists');
        return null;
    } finally {
        leadLock.delete(lockKey);
    }
};

/**
 * Salva a Mensagem no Banco
 */
export const upsertMessage = async (msgData) => {
    try {
        // Delay para garantir que o upsertContact rodou
        await new Promise(resolve => setTimeout(resolve, 300));

        const { error } = await supabase.from('messages').upsert(msgData, { 
            onConflict: 'remote_jid, whatsapp_id' 
        });
        if (error) throw error;
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertMessage');
    }
};

// ==============================================================================
// FUNÇÕES DE COMPATIBILIDADE
// ==============================================================================

export const savePollVote = async (msg, companyId) => {
    try {
        // Placeholder
    } catch (e) {
        logger.error({ err: e.message }, 'Erro savePollVote');
    }
};

export const deleteSessionData = async (sessionId) => {
    await supabase.from('instances').update({ status: 'disconnected' }).eq('session_id', sessionId);
    await supabase.from('baileys_auth_state').delete().eq('session_id', sessionId);
};

export const updateInstance = async (sessionId, data) => {
    await supabase.from('instances').update(data).eq('session_id', sessionId);
};
