
import { createClient } from "@supabase/supabase-js";
import pino from "pino";

// Cliente com privilégios totais (Service Role)
// Necessário para ignorar RLS e garantir escrita em background
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const logger = pino({ level: 'error' });

// MUTEX: Evita criar leads duplicados se receber 10 mensagens simultâneas do mesmo número novo
const leadCreationLock = new Set();

// --- HELPERS ---

// Normaliza JID (Remove sufixos extras, trata grupos e LIDs)
export const normalizeJid = (jid) => {
    if (!jid) return null;
    if (jid.includes('@g.us')) return jid.split('@')[0] + '@g.us';
    if (jid.includes('status@broadcast')) return 'status@broadcast';
    
    // Tratamento de LID (Identidade Oculta) vs Phone
    // Se for LID, mantemos para mapeamento.
    if (jid.includes('@lid')) return jid;
    
    const user = jid.split('@')[0].split(':')[0];
    return `${user}@s.whatsapp.net`;
};

// Valida se um nome é útil (Name Hunter)
const isValidName = (name, phone) => {
    if (!name) return false;
    const clean = name.toString().trim();
    if (clean.length < 1) return false;
    // Lista negra de nomes genéricos que não queremos no CRM
    if (['null', 'undefined', 'unknown', 'usuario', 'contato', 'whatsapp'].includes(clean.toLowerCase())) return false;
    // Se o nome for igual ao telefone, não é um nome válido
    if (phone && clean.replace(/\D/g, '') === phone.replace(/\D/g, '')) return false;
    return true;
};

// --- CORE FUNCTIONS ---

// Atualiza status da instância (QR Code, Sync Bar)
export const updateInstanceStatus = async (sessionId, companyId, data) => {
    try {
        await supabase.from('instances')
            .update({ ...data, updated_at: new Date() })
            .eq('session_id', sessionId)
            .eq('company_id', companyId);
    } catch (e) {
        console.error("Erro updateInstanceStatus:", e.message);
    }
};

// Limpa sessão do banco (Logout)
export const deleteSessionData = async (sessionId, companyId) => {
    try {
        await supabase.from('instances')
            .update({ status: 'disconnected', qrcode_url: null, sync_status: 'waiting' })
            .eq('session_id', sessionId)
            .eq('company_id', companyId);
            
        await supabase.from('baileys_auth_state')
            .delete()
            .eq('session_id', sessionId);
    } catch (e) {
        console.error("Erro deleteSessionData:", e.message);
    }
};

// UPSERT CONTATO (Agenda Inteligente + Identity Map)
export const upsertContact = async ({ jid, companyId, name, pushName, imgUrl, isFromAddressBook }) => {
    if (!jid || !companyId) return;
    
    try {
        const cleanJid = normalizeJid(jid);
        const phone = cleanJid.split('@')[0].replace(/\D/g, '');
        
        const payload = {
            jid: cleanJid,
            company_id: companyId,
            updated_at: new Date()
        };

        // Lógica de Prioridade de Nome
        if (isValidName(pushName, phone)) payload.push_name = pushName;
        
        // Se veio da agenda (sync inicial) OU se temos um nome forte manual
        if (isFromAddressBook && isValidName(name, phone)) {
            payload.name = name;
        }

        if (imgUrl) payload.profile_pic_url = imgUrl;

        // Se não temos nome válido, fazemos um upsert "light" para não apagar dados existentes
        // (Ex: Se o usuário já editou o nome no CRM, não queremos sobrescrever com NULL)
        const { error } = await supabase.from('contacts').upsert(payload, { onConflict: 'company_id, jid' });

        // PROPAGAÇÃO PARA LEADS (Self-Healing)
        // Se descobrimos um nome novo para um contato que já é lead, atualizamos o lead
        if (!error && (isValidName(name, phone) || isValidName(pushName, phone))) {
            const betterName = name || pushName;
            
            // Busca lead que possa estar com nome ruim (apenas número)
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name')
                .eq('company_id', companyId)
                .eq('phone', phone)
                .single();
            
            if (lead && !isValidName(lead.name, phone)) {
                await supabase.from('leads').update({ name: betterName }).eq('id', lead.id);
            }
        }

    } catch (e) {
        // Silencioso para não spammar logs em sync massivo
    }
};

// UPSERT MENSAGEM (Histórico)
export const upsertMessage = async (msgData) => {
    try {
        const cleanRemote = normalizeJid(msgData.remote_jid);
        
        // Evita salvar mensagens de status broadcast no histórico de chat
        if (cleanRemote === 'status@broadcast') return;

        const payload = {
            ...msgData,
            remote_jid: cleanRemote
        };

        await supabase.from('messages').upsert(payload, { onConflict: 'remote_jid, whatsapp_id' });
    } catch (e) {
        console.error("Erro upsertMessage:", e.message);
    }
};

// GARANTIA DE LEAD (Smart Lead Guard com Mutex)
// Cria lead automaticamente se não existir, mas com bloqueio de concorrência
export const ensureLeadExists = async ({ companyId, phone, name, pushName }) => {
    if (!phone || phone.length < 8) return null;
    
    const lockKey = `${companyId}:${phone}`;
    if (leadCreationLock.has(lockKey)) return null; // Já está sendo criado, aborta para evitar duplicata

    try {
        leadCreationLock.add(lockKey);

        // 1. Verifica se já existe
        const { data: existing } = await supabase
            .from('leads')
            .select('id')
            .eq('company_id', companyId)
            .eq('phone', phone)
            .maybeSingle();

        if (existing) return existing.id;

        // 2. Determina melhor nome
        const displayName = isValidName(name, phone) ? name : (isValidName(pushName, phone) ? pushName : `Lead ${phone}`);

        // 3. Busca estágio inicial do funil padrão
        const { data: stage } = await supabase
            .from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (!stage) return null; // Não cria se não tiver funil configurado

        // 4. Cria o Lead
        const { data: newLead, error } = await supabase.from('leads').insert({
            company_id: companyId,
            name: displayName,
            phone: phone,
            status: 'new',
            pipeline_stage_id: stage.id,
            created_at: new Date()
        }).select('id').single();

        if (error) throw error;
        return newLead.id;

    } catch (e) {
        console.error("Erro ensureLeadExists:", e.message);
        return null;
    } finally {
        // Libera lock após 2s (tempo seguro para replicação do banco)
        setTimeout(() => leadCreationLock.delete(lockKey), 2000);
    }
};

// Salva voto de enquete (JSONB Append)
export const savePollVote = async ({ companyId, msgId, voterJid, optionId }) => {
    try {
        // Busca votos atuais
        const { data: msg } = await supabase
            .from('messages')
            .select('poll_votes')
            .eq('whatsapp_id', msgId)
            .eq('company_id', companyId)
            .single();

        if (msg) {
            let votes = Array.isArray(msg.poll_votes) ? msg.poll_votes : [];
            
            // Remove voto anterior desse usuário (Lógica de mudança de voto)
            votes = votes.filter(v => v.voterJid !== voterJid);
            
            // Adiciona novo
            votes.push({ voterJid, optionId, ts: Date.now() });

            await supabase
                .from('messages')
                .update({ poll_votes: votes })
                .eq('whatsapp_id', msgId)
                .eq('company_id', companyId);
        }
    } catch (e) {
        console.error("Erro savePollVote:", e);
    }
};
