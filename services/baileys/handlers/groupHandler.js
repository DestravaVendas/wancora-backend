import { upsertContact, normalizeJid } from '../../crm/sync.js';

/**
 * Processa as atualizações e sincronização de grupos e comunidades
 * Extrai as flags nativas da Meta (isCommunity, linkedParent) e injeta no Supabase.
 */
export const handleGroupsUpsert = async (groups, companyId) => {
    if (!groups || groups.length === 0) return;

    for (const group of groups) {
        if (!group.id) continue;

        const jid = normalizeJid(group.id);
        const name = group.subject || null;
        
        // Extração protegida para não sobrescrever propriedades em payloads parciais (groups.update)
        const extraData = {};
        if (group.isCommunity !== undefined) {
            extraData.is_community = group.isCommunity;
        }
        if (group.linkedParent !== undefined) {
            extraData.parent_jid = group.linkedParent ? normalizeJid(group.linkedParent) : null;
        }

        // Salva/Atualiza o contato no Supabase com as flags de hierarquia
        await upsertContact(
            jid,
            companyId,
            name,            // incomingName (subject do grupo)
            null,            // profilePicUrl (poderíamos buscar, mas faria throttling)
            false,           // isFromBook
            null,            // lid
            false,           // isBusiness
            null,            // verifiedName
            extraData        // As flags vitais
        );
    }
};
