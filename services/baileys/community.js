
import { sessions } from './connection.js';
import { normalizeJid, upsertContact } from '../crm/sync.js';
import axios from 'axios';

// --- COMUNIDADES & GRUPOS ---

/**
 * Cria uma Comunidade (Grupo Pai)
 */
export const createCommunity = async (sessionId, companyId, subject, description) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    // Criação de comunidade é similar a grupo, mas com linkedParent null inicial
    const group = await session.sock.groupCreate(subject, []);
    
    // Atualiza descrição (opcional)
    if (description) {
        await session.sock.groupUpdateDescription(group.id, description);
    }

    // Salva no banco marcando como comunidade
    await upsertContact(group.id, companyId, subject, null, true, null, false, null, { is_community: true });

    return group;
};

export const createGroup = async (sessionId, companyId, subject, participants) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    const pJids = participants.map(p => normalizeJid(p));
    const group = await session.sock.groupCreate(subject, pJids);
    
    await upsertContact(group.id, companyId, subject, null, true);
    return group;
};

export const manageGroupParticipants = async (sessionId, groupId, action, participants) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    const pJids = participants.map(p => normalizeJid(p));
    const response = await session.sock.groupParticipantsUpdate(normalizeJid(groupId), pJids, action);
    return response;
};

export const updateGroupSettings = async (sessionId, groupId, action, value) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");
    
    const jid = normalizeJid(groupId);

    if (action === 'subject') {
        await session.sock.groupUpdateSubject(jid, value);
        const { companyId } = session; 
        if (companyId) await upsertContact(jid, companyId, value, null, true);
    } 
    else if (action === 'description') {
        await session.sock.groupUpdateDescription(jid, value);
    }
    else if (action === 'locked') {
        await session.sock.groupSettingUpdate(jid, value ? 'locked' : 'unlocked');
    }
    else if (action === 'announcement') {
        await session.sock.groupSettingUpdate(jid, value ? 'announcement' : 'not_announcement');
    }
    
    return { success: true };
};

export const updateGroupPicture = async (sessionId, groupId, imageUrl) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");
    
    const jid = normalizeJid(groupId);

    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);

        await session.sock.updateProfilePicture(jid, buffer);
        
        const { companyId } = session;
        if (companyId) {
            await upsertContact(jid, companyId, null, imageUrl, false); 
        }

        return { success: true };
    } catch (e) {
        console.error("Erro ao atualizar foto:", e);
        throw new Error("Falha ao atualizar imagem.");
    }
};

export const getGroupInviteCode = async (sessionId, groupId) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");
    
    const code = await session.sock.groupInviteCode(normalizeJid(groupId));
    return `https://chat.whatsapp.com/${code}`;
};
