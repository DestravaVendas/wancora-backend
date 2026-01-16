
import { createClient } from "@supabase/supabase-js";
import mime from "mime-types";

// --- CONFIGURAÇÃO SUPABASE ---
// Backend DEVE usar a Service Role Key para ignorar RLS em operações de Background/Worker
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERRO FATAL (Sync Service): Chaves do Supabase não encontradas no .env");
}

// Inicializa cliente. 'persistSession: false' é obrigatório para Node.js
const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
});

// --- CACHE & MUTEX (MEMÓRIA RAM) ---
const contactCache = new Set(); 
const leadCreationLock = new Set(); 

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upload de Mídia
 */
export const uploadMediaToSupabase = async (buffer, type) => {
    try {
        const fileExt = mime.extension(type) || 'bin';
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `chat-media/${fileName}`;

        const { error } = await supabase.storage
            .from('chat-media')
            .upload(filePath, buffer, { contentType: type, upsert: false });

        if (error) throw error;

        const { data } = supabase.storage.from('chat-media').getPublicUrl(filePath);
        return data.publicUrl;
    } catch (err) {
        console.error('❌ Erro upload media:', err.message);
        return null;
    }
};

/**
 * Smart Name Update (Lead)
 */
export const smartUpdateLeadName = async (phone, pushName, companyId) => {
    try {
        if (!pushName) return; // Se não tem pushName, não faz nada

        const { data: lead } = await supabase
            .from('leads')
            .select('id, name')
            .eq('phone', phone)
            .eq('company_id', companyId)
            .maybeSingle();

        if (!lead) return;

        // Limpeza básica
        const currentNameClean = lead.name.replace(/\D/g, '');
        const phoneClean = phone.replace(/\D/g, '');
        
        // Só atualiza se o nome atual parecer um número de telefone
        const isGenericName = currentNameClean.includes(phoneClean) || lead.name === phone || lead.name.startsWith('+');

        if (isGenericName && lead.name !== pushName) {
            console.log(`✨ [SMART SYNC] Lead ${phone}: "${lead.name}" -> "${pushName}"`);
            await supabase.from('leads').update({ name: pushName }).eq('id', lead.id);
        }
    } catch (e) {
        console.error("Erro no smartUpdateLeadName:", e);
    }
};

/**
 * Anti-Ghost & Lead Creation
 */
export const ensureLeadExists = async (remoteJid, pushName, companyId) => {
    if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us') || remoteJid.includes('@lid')) return null;
    
    const phone = remoteJid.split('@')[0];
    const lockKey = `${companyId}:${phone}`;

    if (leadCreationLock.has(lockKey)) {
        await delay(1000); 
        const { data: lead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
        return lead?.id || null;
    }

    try {
        leadCreationLock.add(lockKey);

        // 1. Checa Contato Ignorado
        const { data: contact } = await supabase
            .from('contacts')
            .select('is_ignored, name')
            .eq('jid', remoteJid)
            .eq('company_id', companyId)
            .maybeSingle();

        if (contact && contact.is_ignored) return null;

        // 2. Checa Lead Existente
        const { data: existingLead } = await supabase.from('leads').select('id').eq('phone', phone).eq('company_id', companyId).maybeSingle();
        if (existingLead) return existingLead.id;

        // 3. Cria Lead
        console.log(`🆕 [CRM] Novo Lead: ${phone}`);
        const finalName = contact?.name || pushName || `+${phone}`; 

        const { data: firstStage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', companyId)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();
        
        const { data: newLead } = await supabase.from('leads').insert({
            company_id: companyId,
            name: finalName,
            phone: phone,
            status: 'new',
            pipeline_stage_id: firstStage?.id || null 
        }).select('id').single();

        return newLead?.id || null;

    } catch (e) {
        console.error("Erro ensureLeadExists:", e.message);
        return null;
    } finally {
        leadCreationLock.delete(lockKey);
    }
};

/**
 * Upsert Contact (Safe)
 */
export const upsertContact = async (jid, sock, pushName = null, companyId = null, savedName = null, imgUrl = null) => {
    try {
        let suffix = '@s.whatsapp.net';
        if (jid.includes('@g.us')) suffix = '@g.us';
        if (jid.includes('@lid')) suffix = '@lid';

        const cleanJid = jid.split(':')[0] + suffix;
        const cacheKey = `${companyId}:${cleanJid}`;
        
        const hasNewInfo = pushName || savedName || imgUrl;
        
        // Cache Check
        if (contactCache.has(cacheKey) && !hasNewInfo) return; 

        const contactData = { 
            jid: cleanJid, 
            company_id: companyId, 
            updated_at: new Date() 
        };
        
        // Proteção: Só sobrescreve se o valor não for nulo/undefined
        if (savedName) contactData.name = savedName; 
        if (pushName) contactData.push_name = pushName;
        if (imgUrl) contactData.profile_pic_url = imgUrl;

        const { error } = await supabase.from('contacts').upsert(contactData, { onConflict: 'jid' });
        
        if (!error) {
            contactCache.add(cacheKey);
            setTimeout(() => contactCache.delete(cacheKey), 10 * 60 * 1000);
        }
    } catch (e) {
        // Silencioso
    }
};

/**
 * Save Message
 */
export const saveMessageToDb = async ({
    companyId, sessionId, remoteJid, whatsappId, fromMe, content, messageType, mediaUrl, leadId, timestamp
}) => {
    const { error } = await supabase.from('messages').upsert({
        company_id: companyId,
        session_id: sessionId,
        remote_jid: remoteJid,
        whatsapp_id: whatsappId,
        from_me: fromMe,
        content: content,
        message_type: messageType,
        media_url: mediaUrl,
        status: fromMe ? 'sent' : 'received',
        lead_id: leadId,
        created_at: timestamp ? new Date(timestamp * 1000) : new Date()
    }, { 
        onConflict: 'remote_jid, whatsapp_id'
    });

    if (error) console.error(`❌ [DB] Msg Error:`, error.message);
};

export const updateInstance = async (sessionId, data) => {
    await supabase.from("instances").update({ ...data, updated_at: new Date() }).eq('session_id', sessionId);
};

export const deleteSessionData = async (sessionId) => {
    await supabase.from("instances").delete().eq("session_id", sessionId);
    await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);
};

export { supabase };
