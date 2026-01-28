
import { sessions } from './connection.js';
import { normalizeJid, upsertContact } from '../crm/sync.js';
import axios from 'axios';

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
        const { companyId } = session; 
        if (companyId) await upsertContact(jid, companyId, value, null, true);
    } 
    else if (action === 'description') {
        await session.sock.groupUpdateDescription(jid, value);
    }
    else if (action === 'locked') {
        // value=true: Apenas admins editam info
        await session.sock.groupSettingUpdate(jid, value ? 'locked' : 'unlocked');
    }
    else if (action === 'announcement') {
        // value=true: Apenas admins enviam msg
        await session.sock.groupSettingUpdate(jid, value ? 'announcement' : 'not_announcement');
    }
    
    return { success: true };
};

// Funçao Especial para Atualizar Foto (Grupo ou Perfil)
export const updateGroupPicture = async (sessionId, groupId, imageUrl) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");
    
    const jid = normalizeJid(groupId);

    try {
        // Baixa a imagem da URL (Supabase ou externa) para um Buffer
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);

        // Atualiza no WhatsApp
        await session.sock.updateProfilePicture(jid, buffer);
        
        // Atualiza no Banco CRM
        const { companyId } = session;
        if (companyId) {
            // Note: Não mudamos o nome aqui, passamos null
            await upsertContact(jid, companyId, null, imageUrl, false); 
        }

        return { success: true };
    } catch (e) {
        console.error("Erro ao atualizar foto de grupo:", e);
        throw new Error("Falha ao atualizar imagem.");
    }
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

    await session.sock.newsletterUnfollow(channelId);
    return { success: true };
};
