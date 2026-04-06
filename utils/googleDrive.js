import { google } from 'googleapis';
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Retorna um cliente autenticado do Google Drive para a empresa
 */
export const getDriveClient = async (companyId) => {
    try {
        const { data: integration, error } = await supabase
            .from('integrations_google')
            .select('*')
            .eq('company_id', companyId)
            .single();

        if (error || !integration) {
            console.error(`❌ [DRIVE] Integração não encontrada para empresa ${companyId}`);
            return null;
        }

        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_DRIVE_CLIENT_ID,
            process.env.GOOGLE_DRIVE_CLIENT_SECRET
        );

        oauth2Client.setCredentials({
            access_token: integration.access_token,
            refresh_token: integration.refresh_token,
            expiry_date: integration.expiry_date,
            token_type: integration.token_type
        });

        // Verifica se o token expirou e renova se necessário
        oauth2Client.on('tokens', async (tokens) => {
            if (tokens.refresh_token) {
                // Atualiza o refresh token se ele mudar
                await supabase.from('integrations_google').update({
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    expiry_date: tokens.expiry_date,
                    updated_at: new Date()
                }).eq('company_id', companyId);
            } else {
                await supabase.from('integrations_google').update({
                    access_token: tokens.access_token,
                    expiry_date: tokens.expiry_date,
                    updated_at: new Date()
                }).eq('company_id', companyId);
            }
        });

        return google.drive({ version: 'v3', auth: oauth2Client });

    } catch (e) {
        console.error(`❌ [DRIVE] Erro ao autenticar Drive para empresa ${companyId}:`, e.message);
        return null;
    }
};
