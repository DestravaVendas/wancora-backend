
import { google } from 'googleapis';
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const SCOPES = [
    'https://www.googleapis.com/auth/drive',        // Acesso total (Upload/List/Download)
    'https://www.googleapis.com/auth/userinfo.email' // Identificar usuário
];

/**
 * Factory para criar cliente OAuth
 */
const createOAuthClient = () => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
        throw new Error("Credenciais do Google não configuradas no .env");
    }
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
};

/**
 * Gera URL de Login para o usuário
 */
export const generateAuthUrl = (companyId) => {
    const oauth2Client = createOAuthClient();
    
    // state: Passamos o companyId para saber quem está autenticando no callback
    return oauth2Client.generateAuthUrl({
        access_type: 'offline', // CRÍTICO: Garante o refresh_token
        scope: SCOPES,
        state: companyId,
        prompt: 'consent' // Força tela de permissão para garantir refresh_token
    });
};

/**
 * Troca código por tokens e salva no banco
 */
export const handleAuthCallback = async (code, companyId) => {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
        console.warn(`[GOOGLE] Refresh Token não retornado para company ${companyId}. Revogue acesso e tente novamente.`);
        // Nota: Google só envia refresh_token na primeira vez. Se perder, usuário precisa revogar acesso no Google Account.
    }

    // Identifica usuário
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    // Upsert Tokens
    const payload = {
        company_id: companyId,
        email: userInfo.email,
        access_token: tokens.access_token,
        token_type: tokens.token_type,
        expiry_date: tokens.expiry_date,
        updated_at: new Date()
    };

    // Só atualiza refresh_token se vier um novo (para não sobrescrever com null em re-auths parciais)
    if (tokens.refresh_token) {
        payload.refresh_token = tokens.refresh_token;
    }

    const { error } = await supabase
        .from('integrations_google')
        .upsert(payload, { onConflict: 'company_id' });

    if (error) throw error;
    return userInfo;
};

/**
 * Obtém cliente autenticado (Auto-Refresh)
 * @param {string} companyId 
 * @returns {Promise<google.auth.OAuth2>}
 */
export const getAuthenticatedClient = async (companyId) => {
    const { data: config } = await supabase
        .from('integrations_google')
        .select('*')
        .eq('company_id', companyId)
        .single();

    if (!config || !config.refresh_token) {
        throw new Error("Integração com Google Drive não encontrada ou inválida.");
    }

    const oauth2Client = createOAuthClient();
    
    oauth2Client.setCredentials({
        access_token: config.access_token,
        refresh_token: config.refresh_token,
        expiry_date: config.expiry_date,
        token_type: config.token_type
    });

    // Interceptor para salvar novo access_token se houver refresh automático
    oauth2Client.on('tokens', async (tokens) => {
        if (tokens.access_token) {
            console.log(`🔄 [GOOGLE] Token renovado para ${companyId}`);
            await supabase.from('integrations_google')
                .update({
                    access_token: tokens.access_token,
                    expiry_date: tokens.expiry_date,
                    updated_at: new Date()
                })
                .eq('company_id', companyId);
        }
    });

    return oauth2Client;
};
