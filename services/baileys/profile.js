
import { sessions } from './connection.js';
import axios from 'axios';

export const updateProfileName = async (sessionId, newName) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    await session.sock.updateProfileName(newName);
    return { success: true };
};

export const updateProfileStatus = async (sessionId, newStatus) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    await session.sock.updateProfileStatus(newStatus);
    return { success: true };
};

export const updateProfilePic = async (sessionId, imageUrl) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");
    
    // O JID do próprio usuário
    const myJid = session.sock.user?.id.split(':')[0] + '@s.whatsapp.net';

    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        await session.sock.updateProfilePicture(myJid, buffer);
        return { success: true };
    } catch (e) {
        throw new Error("Falha ao atualizar foto de perfil: " + e.message);
    }
};

export const updatePrivacy = async (sessionId, setting) => {
    // setting: { readreceipts: 'all' | 'none', profile: 'all' | 'contacts' | 'none', etc }
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    // Baileys não tem um método único unificado simples para todas privacidades na versão atual,
    // mas expõe métodos específicos como updateLastSeenPrivacy, etc.
    // Implementação placeholder para expansão futura conforme a lib estabiliza essa API.
    
    return { message: "Ajuste de privacidade será implementado na próxima versão da lib." };
};
