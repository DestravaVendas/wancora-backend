import { createClient } from '@supabase/supabase-js';
import getRedisClient from '../../../redisClient.js';
import { Logger } from '../../../utils/logger.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

class IdentityResolver {
    constructor() {
        // Fallback em memória (Ram LRU) caso o Redis não esteja disponível.
        // Array de [{ key, value, expiresAt }]
        this.memoryCache = new Map();
        // Limpeza de memória a cada 5 min
        this.ttlSeconds = 600; // 10 min de TTL
        
        setInterval(() => this._cleanupMemoryCache(), 60000);
    }

    _cleanupMemoryCache() {
        const now = Date.now();
        for (const [key, data] of this.memoryCache.entries()) {
            if (data.expiresAt < now) {
                this.memoryCache.delete(key);
            }
        }
    }

    async _getFromCache(key) {
        const redis = getRedisClient();
        if (redis && redis.status === 'ready') {
            return await redis.get(key);
        }
        
        const data = this.memoryCache.get(key);
        if (data && data.expiresAt > Date.now()) {
            return data.value;
        }
        return null;
    }

    async _setToCache(key, value) {
        const redis = getRedisClient();
        if (redis && redis.status === 'ready') {
            await redis.set(key, value, 'EX', this.ttlSeconds);
        } else {
            this.memoryCache.set(key, { value, expiresAt: Date.now() + (this.ttlSeconds * 1000) });
        }
    }

    /**
     * Resolve um JID. Se for um @lid, tenta achar o telefone verdadeiro (@s.whatsapp.net).
     * Se falhar, retorna o próprio LID. Em 100% dos casos ele usa o Cache antes de perturbar o Supabase.
     */
    async resolveIdentity(jid, companyId) {
        // Se já for um telefone real, retorna direto
        if (!jid || !jid.includes('@lid')) return jid;

        const cacheKey = `lid_resolver:${companyId}:${jid}`;
        const cachedJid = await this._getFromCache(cacheKey);

        if (cachedJid) {
            // Se cacheamos 'null_str', significa que já falhamos em achar há pouco tempo. Economiza DB.
            if (cachedJid === 'null_str') return jid;
            return cachedJid;
        }

        let resolvedJid = null;

        try {
            // ── Camada 1: Hard Resolution via identity_map ──────────────
            const { data: mapping } = await supabase
                .from('identity_map')
                .select('phone_jid')
                .eq('lid_jid', jid)
                .eq('company_id', companyId)
                .maybeSingle();

            if (mapping?.phone_jid) {
                resolvedJid = mapping.phone_jid;
            }


            // ── Camada 2: Busca o @lid diretamente na tabela contacts com phone ──
            // O historyHandler pode ter salvo o contato com jid = @lid e phone preenchido.
            // Essa é a rota mais rápida quando identity_map ainda não foi populado.
            if (!resolvedJid) {
                const { data: contactByLid } = await supabase
                    .from('contacts')
                    .select('phone')
                    .eq('company_id', companyId)
                    .eq('jid', jid)          // busca o @lid como JID direto
                    .not('phone', 'is', null)
                    .maybeSingle();

                if (contactByLid?.phone) {
                    const cleanPhone = contactByLid.phone.replace(/\D/g, '');
                    if (cleanPhone.length >= 8) {
                        resolvedJid = `${cleanPhone}@s.whatsapp.net`;
                    }
                }
            }

            // ── Camada 3: Busca em messages um canonical_jid já resolvido para este @lid ──
            // Garante que conversas com histórico parcial não percam o vínculo.
            if (!resolvedJid) {
                const { data: existingMsg } = await supabase
                    .from('messages')
                    .select('canonical_jid')
                    .eq('company_id', companyId)
                    .eq('remote_jid', jid)
                    .not('canonical_jid', 'is', null)
                    .limit(1)
                    .maybeSingle();

                if (existingMsg?.canonical_jid) {
                    resolvedJid = existingMsg.canonical_jid;
                }
            }


            // ── Persistência de Descoberta ─────────────
            if (resolvedJid) {
                await this._setToCache(cacheKey, resolvedJid);
                
                // Fire-and-forget: salva o mapeamento no banco para próximas requisições
                supabase.rpc('link_identities', {
                    p_lid: jid,
                    p_phone: resolvedJid,
                    p_company_id: companyId
                }).then(({ error }) => { if (error) console.error("❌ [LID] RPC Error:", error.message); }).catch(() => {});
                
                Logger.info('baileys', `[LID] Identidade Mapeada: ${jid} → ${resolvedJid}`, {}, companyId);
                return resolvedJid;
            } else {
                // Previne buscar no DB na próxima mensagem
                await this._setToCache(cacheKey, 'null_str');
                return jid;
            }

        } catch (error) {
            Logger.error('baileys', `[LID] Erro ao resolver identidade para ${jid}`, { error: error.message }, companyId);
            return jid; // Em vez de falhar a mensagem, engole cego
        }
    }
}

export const identityResolver = new IdentityResolver();
