
import { sessions } from './connection.js';
import { normalizeJid, upsertContact } from '../crm/sync.js';
import { delay } from '@whiskeysockets/baileys';

// --- GRUPOS ---

export const createGroup = async (sessionId, companyId, subject, participants) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    // Normaliza participantes
    const pJids = participants.map(p => normalizeJid(p));

    // Cria o grupo
    const group = await session.sock.groupCreate(subject, pJids);
    
    // Salva imediatamente no banco para aparecer na UI
    await upsertContact(group.id, companyId, subject, null, true);

    return group;
};

export const manageGroupParticipants = async (sessionId, groupId, action, participants) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    const pJids = participants.map(p => normalizeJid(p));
    // action: 'add' | 'remove' | 'promote' | 'demote'
    const response = await session.sock.groupParticipantsUpdate(normalizeJid(groupId), pJids, action);
    return response;
};

export const updateGroupSettings = async (sessionId, groupId, action, value) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");
    
    const jid = normalizeJid(groupId);

    if (action === 'subject') {
        await session.sock.groupUpdateSubject(jid, value);
        // Atualiza nome no banco Wancora
        const { companyId } = session; // Recupera companyId da sessão em memória
        if (companyId) await upsertContact(jid, companyId, value, null, true);
    } 
    else if (action === 'description') {
        await session.sock.groupUpdateDescription(jid, value);
    }
    else if (action === 'locked') {
        // Apenas admins podem alterar configurações
        await session.sock.groupSettingUpdate(jid, value ? 'locked' : 'unlocked');
    }
    else if (action === 'announcement') {
        // Apenas admins podem enviar mensagens
        await session.sock.groupSettingUpdate(jid, value ? 'announcement' : 'not_announcement');
    }
    
    return { success: true };
};

export const getGroupInviteCode = async (sessionId, groupId) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");
    
    const code = await session.sock.groupInviteCode(normalizeJid(groupId));
    return `https://chat.whatsapp.com/${code}`;
};

// --- CANAIS (NEWSLETTERS) ---

export const createChannel = async (sessionId, companyId, name, description) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    // Função nativa do Baileys para Newsletter
    const newsletter = await session.sock.newsletterCreate(name, {
        description: description,
        reactionCodesSetting: 'all' // Permite todas as reações
    });

    // Salva no banco Wancora para aparecer na lista
    if (newsletter && newsletter.id) {
        await upsertContact(newsletter.id, companyId, name, null, true);
    }

    return newsletter;
};

export const toggleChannelMute = async (sessionId, channelId, mute) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    if (mute) await session.sock.newsletterMute(channelId);
    else await session.sock.newsletterUnmute(channelId);

    return { success: true, muted: mute };
};

export const deleteChannel = async (sessionId, channelId) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    // Baileys não tem um "delete" direto documentado publicamente em todas versões,
    // mas geralmente é tratado como unsubscribe ou delete via query.
    // Implementação segura: Unfollow/Unsubscribe
    await session.sock.newsletterUnfollow(channelId);
    return { success: true };
};
