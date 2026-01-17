import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase
// Garante que usa as variáveis de ambiente carregadas no server.js
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Cache removido da lógica crítica para garantir salvamento agressivo
const contactCache = new Set();
const leadLock = new Set(); // Mutex para evitar duplicidade na criação de leads

/**
 * Atualiza o status da sincronização na tabela 'instances'
 * Isso permite que o Frontend mostre "Sincronizando 45%..."
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
    } catch (e) {
        // Ignora erros de log para não travar o fluxo principal
    }
};

/**
 * Verifica se um nome parece ser apenas um número de telefone ou genérico.
 * Retorna TRUE se for um nome "ruim" (que DEVEMOS substituir).
 */
const isGenericName = (name, phone) => {
    if (!name) return true; // Se não tem nome, é ruim.
    
    // Limpeza para comparação
    const cleanName = name.replace(/\D/g, ''); 
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Critérios de nome ruim (Agressivo):
    return cleanName.includes(cleanPhone) || 
           name === phone || 
           name.startsWith('+') || 
           (cleanName.length > 7 && /[0-9]{5,}/.test(name));
};

/**
 * Upsert Inteligente de Contato (MODO AGRESSIVO + PROPAGAÇÃO PARA LEADS)
 */
export const upsertContact = async (jid, companyId, pushName = null, profilePicUrl = null) => {
    try {
        if (!jid || !companyId) return;
        
        const isGroup = jid.includes('@g.us');
        const cleanJid = jid.split('@')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
        const phone = cleanJid.split('@')[0];
        
        // 1. Busca dados atuais para decidir a prioridade do nome
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
            last_message_at: new Date() // Garante topo do sidebar
        };

        let finalName = current?.name;
        let shouldUpdateLead = false;

        // --- LÓGICA DE PRIORIDADE DE NOME (AGRESSIVA) ---
        if (pushName && pushName.trim().length > 0) {
            updateData.push_name = pushName;
            
            const currentName = current?.name;
            const isCurrentBad = !current || !currentName || isGenericName(currentName, phone);

            if (isCurrentBad) {
                updateData.name = pushName;
                finalName = pushName;    // Capturamos o nome novo
                shouldUpdateLead = true; // Sinalizamos para atualizar o lead também
            }
        } else if (!current) {
            // Se é contato novo e não veio nome nenhum, usa o número formatado como fallback
            updateData.name = `+${phone}`;
            finalName = `+${phone}`;
        }

        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
        }

        // 2. Realiza o Upsert no Contato
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        if (error) {
            console.error('[CONTACT SYNC ERROR]', error.message);
        } else if (shouldUpdateLead && finalName && !isGroup) {
            // --- 3. PROPAGAÇÃO PARA LEADS (A PEÇA QUE FALTAVA) ---
            // Se descobrimos um nome novo e não é grupo, atualizamos o Lead correspondente
            // para que o Kanban e o Chat mostrem o nome real, não o número.
            await supabase.from('leads')
                .update({ name: finalName })
                .eq('company_id', companyId)
                .eq('phone', phone)
                .neq('name', finalName); // Só atualiza se for diferente para economizar banco
        }

    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

/**
 * Garante que o Lead existe na tabela 'leads' (Anti-Ghost)
 */
export const ensureLeadExists = async (jid, companyId, pushName) => {
    // Ignora grupos e broadcast
    if (jid.includes('@g.us') || jid.includes('status@broadcast')) return null;

    const phone = jid.split('@')[0];
    const lockKey = `${companyId}:${phone}`;

    // Mutex: Se já estamos criando este lead agora, retorna null para evitar duplicidade
    if (leadLock.has(lockKey)) return null;

    try {
        leadLock.add(lockKey);

        // Verifica se já existe
        const { data: existing } = await supabase
            .from('leads')
            .select('id, name')
            .eq('phone', phone)
            .eq('company_id', companyId)
            .maybeSingle();

        if (existing) {
            // FIX: Se o lead já existe, mas o nome é genérico e agora temos um bom, atualiza!
            if (pushName && isGenericName(existing.name, phone)) {
                await supabase.from('leads')
                    .update({ name: pushName })
                    .eq('id', existing.id);
            }
            return existing.id;
        }

        // Se não existe, cria
        const nameToUse = pushName || `+${phone}`;
        
        // Busca a primeira etapa do funil (Pipeline) para colocar o lead novo
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
        // --- DELAY AUMENTADO PARA 300ms ---
        // Essencial para dar tempo do upsertContact rodar antes da mensagem ser salva
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
