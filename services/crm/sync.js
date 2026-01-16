import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase
// Garante que usa as variáveis de ambiente carregadas no server.js
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Cache simples mantido, mas vamos ignorá-lo na lógica crítica abaixo
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
 * Verifica se um nome parece ser apenas um número de telefone ou genérico
 * Retorna TRUE se for um nome "ruim" (que podemos substituir)
 */
const isGenericName = (name, phone) => {
    if (!name) return true;
    const cleanName = name.replace(/\D/g, ''); // Remove tudo que não é número
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Se o nome for igual ao telefone, ou conter o telefone, é genérico
    return cleanName.includes(cleanPhone) || name === phone || name.startsWith('+');
};

/**
 * Upsert Inteligente de Contato (Com Proteção de Nome - Build Arquiteto)
 */
export const upsertContact = async (jid, companyId, pushName = null, profilePicUrl = null) => {
    try {
        if (!jid || !companyId) return;
        
        const isGroup = jid.includes('@g.us');
        const cleanJid = jid.split('@')[0] + (isGroup ? '@g.us' : '@s.whatsapp.net');
        const phone = cleanJid.split('@')[0];
        
        // --- ALTERAÇÃO 1: CACHE DESATIVADO PARA FORÇAR SALVAMENTO ---
        // Comentamos a verificação de cache para garantir que o contato SEMPRE tente ser salvo/atualizado
        // const cacheKey = `${companyId}:${cleanJid}`;
        // if (contactCache.has(cacheKey) && !pushName && !profilePicUrl) return;

        // 1. Busca dados atuais para decidir a prioridade do nome
        // Usamos maybeSingle para não dar erro se não existir
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
            updated_at: new Date()
        };

        // --- LÓGICA DE PRIORIDADE DE NOME ---
        if (pushName) {
            updateData.push_name = pushName;
            
            if (!current || !current.name) {
                // Cenário 1: Contato novo ou sem nome -> Aceita o PushName
                updateData.name = pushName;
            } else if (isGenericName(current.name, phone)) {
                // Cenário 2: Nome atual é ruim (é o número) -> Aceita o PushName melhor
                updateData.name = pushName;
            } else {
                // Cenário 3: Já tem um nome bom definido manualmente -> IGNORA o PushName no campo 'name'
                // Mantém o nome que estava no banco (para não perder edição manual)
            }
        }

        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
        }

        // Realiza o Upsert no Supabase
        // Adicionamos um tratamento extra de erro aqui
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        if (error) {
            // Loga erro mas não para o fluxo
            console.error('[CONTACT SYNC ERROR]', error.message);
        } else {
            // Adiciona ao cache só depois de salvar com sucesso
            // contactCache.add(cacheKey); 
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
            .select('id')
            .eq('phone', phone)
            .eq('company_id', companyId)
            .maybeSingle();

        if (existing) return existing.id;

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
        // --- ALTERAÇÃO 2: DELAY ARTIFICIAL PARA FREAR O DOWNLOAD ---
        // Isso dá tempo ao Baileys para resolver nomes de contatos antes de salvar a próxima mensagem.
        // 150ms de pausa a cada mensagem.
        await new Promise(resolve => setTimeout(resolve, 150));

        const { error } = await supabase.from('messages').upsert(msgData, { 
            onConflict: 'remote_jid, whatsapp_id' 
        });
        if (error) throw error;
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertMessage');
    }
};

// ==============================================================================
// FUNÇÕES DE COMPATIBILIDADE (CORREÇÃO DO ERRO DE DEPLOY)
// ==============================================================================

// ESTA FUNÇÃO É OBRIGATÓRIA PARA NÃO QUEBRAR O WHATSAPPCONTROLLER.JS
export const savePollVote = async (msg, companyId) => {
    try {
        // Placeholder: Se você não usa enquetes agora, pode deixar vazio.
        // A função precisa existir para o 'import' funcionar.
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
