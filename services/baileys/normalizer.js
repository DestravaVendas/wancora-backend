
import { normalizeJid } from "../../utils/wppParsers.js";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * 🛡️ [NORMALIZER SERVICE]
 * Centraliza a lógica de normalização e resolução de JIDs (LID -> Phone).
 * Garante que o sistema sempre use o JID canônico para evitar duplicidade.
 */
export class Normalizer {
    
    /**
     * Resolve um JID (que pode ser LID) para o JID de telefone real.
     */
    static async resolve(jid, companyId, myJid = null) {
        if (!jid) return null;
        
        const cleanJid = normalizeJid(jid);
        const pureId = cleanJid.split('@')[0];

        // 🛡️ [SELF-DETECTION] Se o JID for o meu próprio, retorna o canônico 'me' ou o telefone
        if (myJid) {
            const cleanMyJid = normalizeJid(myJid);
            if (cleanJid === cleanMyJid) return cleanMyJid;
        }
        
        // 🛡️ [DETECÇÃO TÉCNICA] 
        const isTechnicalId = cleanJid.includes('@lid') || (pureId.length > 13 && /^\d+$/.test(pureId));
        if (!isTechnicalId) return cleanJid;

        try {
            // 1. Hard Resolution (Mapa de Identidade no DB)
            const { data } = await supabase
                .from('identity_map')
                .select('phone_jid')
                .eq('lid_jid', cleanJid)
                .eq('company_id', companyId)
                .maybeSingle();

            if (data?.phone_jid) return normalizeJid(data.phone_jid);

            // 2. Fallback: Se for um LID mascarado em @s.whatsapp.net, tenta buscar a versão @lid
            if (cleanJid.includes('@s.whatsapp.net')) {
                 const lidEquivalent = cleanJid.replace('@s.whatsapp.net', '@lid');
                 const { data: inverseMap } = await supabase
                    .from('identity_map')
                    .select('phone_jid')
                    .eq('lid_jid', lidEquivalent)
                    .eq('company_id', companyId)
                    .maybeSingle();
                 if (inverseMap?.phone_jid) return normalizeJid(inverseMap.phone_jid);
            }

            // 3. Heurística: Se o ID técnico PARECE um telefone (ex: 55...), assume como tal
            if (pureId.length >= 10 && pureId.startsWith('55') && !cleanJid.includes('@lid')) {
                const phoneJid = `${pureId}@s.whatsapp.net`;
                // Registra o vínculo para futuras mensagens via RPC
                supabase.rpc('link_identities', { 
                    p_lid: cleanJid, 
                    p_phone: phoneJid, 
                    p_company_id: companyId 
                }).catch(() => {});
                
                return phoneJid;
            }
            
            return cleanJid;
        } catch (e) {
            console.error(`❌ [NORMALIZER] Erro ao resolver JID ${jid}:`, e.message);
            return cleanJid;
        }
    }

    /**
     * Limpa um JID para obter apenas o número de telefone (sem @s.whatsapp.net).
     */
    static toPhone(jid) {
        if (!jid) return null;
        const clean = normalizeJid(jid);
        if (clean.includes('@g.us')) return null;
        return clean.split('@')[0].replace(/\D/g, '');
    }

    /**
     * Verifica se um JID é técnico (LID).
     */
    static isLid(jid) {
        if (!jid) return false;
        return jid.includes('@lid') || (jid.split('@')[0].length > 13 && /^\d+$/.test(jid.split('@')[0]));
    }
}
