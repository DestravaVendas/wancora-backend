import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Inicializa o cliente Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const logger = pino({ level: 'error' });

// Cache removido da lógica crítica para garantir salvamento agressivo
const contactCache = new Set();
const leadLock = new Set(); // Mutex para evitar duplicidade na criação de leads

// --- FUNÇÃO AUXILIAR NECESSÁRIA PARA A LÓGICA ---
// Verifica se um nome parece ser apenas um número de telefone ou genérico.
const isGenericName = (name, phone) => {
    if (!name) return true;
    // PONTO CRUCIAL 3: Regex Agressiva (Limpa tudo para comparar apenas dígitos)
    const cleanName = name.replace(/\D/g, '');
    const cleanPhone = phone.replace(/\D/g, '');
    
    // Regra: Se o nome só tem números e símbolos, ou contém o próprio telefone, é genérico.
    const isJustNumbersAndSymbols = /^[\d\+\-\(\)\s]+$/.test(name);

    return cleanName.includes(cleanPhone) || 
           name === phone || 
           name.startsWith('+') || 
           isJustNumbersAndSymbols ||
           (cleanName.length > 7 && /[0-9]{5,}/.test(name));
};

// Atualiza o status da sincronização na tabela 'instances'
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
        // Ignora erros de log
    }
};

// Upsert Inteligente de Contato (MODO AGRESSIVO + PROPAGAÇÃO PARA LEADS)
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
            phone: phone, // AQUI salvamos o número
            company_id: companyId,
            updated_at: new Date(),
            last_message_at: new Date() // Garante topo do sidebar
        };

        let finalName = current?.name;
        let shouldUpdateLead = false;

        // --- LÓGICA DE PRIORIDADE DE NOME (AGRESSIVA v2) ---
        if (pushName && pushName.trim().length > 0 && !isGenericName(pushName, phone)) {
            updateData.push_name = pushName;
            
            const currentName = current?.name;
            // Se o nome atual for nulo ou for genérico (numero), substituímos pelo PushName
            const isCurrentBad = !currentName || isGenericName(currentName, phone);

            if (isCurrentBad) {
                updateData.name = pushName; // <--- AQUI ELE SALVA O NOME REAL
                finalName = pushName;    
                shouldUpdateLead = true; 
            }
        } else if (!current) {
            // PONTO CRUCIAL 2: Se é novo e sem nome, salva NULL.
            // JAMAIS salvar o telefone na coluna 'name' aqui.
            updateData.name = null; 
            finalName = null; 
        } else if (current && isGenericName(current.name, phone)) {
            // Se já existe mas o nome salvo é um número, limpamos para NULL
            updateData.name = null;
        }

        if (profilePicUrl) {
            updateData.profile_pic_url = profilePicUrl;
        }

        // 2. Realiza o Upsert no Contato
        const { error } = await supabase.from('contacts').upsert(updateData, { onConflict: 'company_id, jid' });

        if (error) {
            console.error('[CONTACT SYNC ERROR]', error.message);
        } else if (shouldUpdateLead && finalName && !isGroup) {
            // 3. Propagação para Leads
            await supabase.from('leads')
                .update({ name: finalName })
                .eq('company_id', companyId)
                .eq('phone', phone)
                .neq('name', finalName); 
        }
    } catch (e) {
        logger.error({ err: e.message }, 'Erro upsertContact');
    }
};

// Garante que o Lead existe na tabela 'leads' (Anti-Ghost)
export const ensureLeadExists = async (jid, companyId, pushName) => {
    // Verifica e Bloqueia: Grupos, Status, Canais e IDs Ocultos
    if (
        !jid || 
        jid.endsWith('@g.us') ||            
        jid.includes('-') ||                
        jid.includes('status@broadcast') || 
        jid.endsWith('@newsletter') ||      
        jid.endsWith('@lid')                
    ) {
        return null; 
    }

    const phone = jid.split('@')[0];
    // Validação extra: Se o "phone" não parecer um número, aborta
    if (!/^\d+$/.test(phone)) return null;
    
    const lockKey = `${companyId}:${phone}`;
    
    // Mutex
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
            if (pushName && !isGenericName(pushName, phone) && isGenericName(existing.name, phone)) {
                await supabase.from('leads')
                    .update({ name: pushName })
                    .eq('id', existing.id);
            }
            return existing.id;
        }

        // Se não existe, cria.
        // PONTO CRUCIAL (REMOÇÃO LEAD 1234): Usa o nome ou o próprio telefone.
        const nameToUse = (pushName && !isGenericName(pushName, phone)) ? pushName : phone;
        
        // Busca a primeira etapa do funil
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

// Salva a Mensagem no Banco
export const upsertMessage = async (msgData) => {
    try {
        // Delay para dar tempo do upsertContact rodar
        await new Promise(resolve => setTimeout(resolve, 250));

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
