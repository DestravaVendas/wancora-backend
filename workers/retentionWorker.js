
import cron from 'node-cron';
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedClient } from '../services/google/authService.js';
import { google } from 'googleapis';
import { Readable } from 'stream';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const getOrCreateFolder = async (auth, folderName) => {
    const drive = google.drive({ version: 'v3', auth });
    const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id)' });
    
    if (res.data.files.length > 0) return res.data.files[0].id;
    
    const meta = { name: folderName, mimeType: 'application/vnd.google-apps.folder' };
    const createRes = await drive.files.create({ resource: meta, fields: 'id' });
    return createRes.data.id;
};

const processRetention = async () => {
    console.log("♻️ [RETENTION] Iniciando ciclo de limpeza de mídia...");
    
    try {
        const { data: companies } = await supabase.from('companies').select('id, storage_retention_days').eq('status', 'active');
        if (!companies) return;

        for (const company of companies) {
            const retentionDays = company.storage_retention_days || 30;
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
            
            // 1. Busca mensagens com mídia antiga (que ainda não foram arquivadas)
            // Assumimos que mídias arquivadas tem 'archived' em algum metadado ou apenas deletamos
            // Para simplificar, buscamos mensagens com media_url do Supabase
            const { data: msgs } = await supabase
                .from('messages')
                .select('id, media_url, message_type, content')
                .eq('company_id', company.id)
                .lte('created_at', cutoffDate.toISOString())
                .ilike('media_url', '%supabase.co%') // Apenas URLs do Supabase
                .limit(50); // Lote pequeno para não estourar memória

            if (!msgs || msgs.length === 0) continue;

            console.log(`♻️ [RETENTION] Processando ${msgs.length} arquivos para empresa ${company.id}`);

            let auth;
            try {
                auth = await getAuthenticatedClient(company.id);
            } catch (e) {
                console.warn(`⚠️ [RETENTION] Falha auth Google para ${company.id}, pulando.`);
                continue;
            }

            const drive = google.drive({ version: 'v3', auth });
            const folderId = await getOrCreateFolder(auth, 'Lixeira Wancora (Arquivos Antigos)');

            for (const msg of msgs) {
                try {
                    // Extrai caminho do storage
                    const urlParts = msg.media_url.split('/chat-media/');
                    if (urlParts.length < 2) continue;
                    const storagePath = urlParts[1];

                    // Baixa do Supabase
                    const { data: blob, error } = await supabase.storage.from('chat-media').download(storagePath);
                    if (error) {
                        console.error("Erro download supabase:", error);
                        continue;
                    }

                    // Upload para Drive
                    const buffer = Buffer.from(await blob.arrayBuffer());
                    const stream = new Readable();
                    stream.push(buffer);
                    stream.push(null);

                    const fileName = `${msg.message_type}_${msg.id.split('-')[0]}.dat`; // Nome genérico com ID

                    const driveRes = await drive.files.create({
                        resource: { name: fileName, parents: [folderId] },
                        media: { mimeType: blob.type, body: stream },
                        fields: 'webViewLink'
                    });

                    // Deleta do Supabase Storage
                    await supabase.storage.from('chat-media').remove([storagePath]);

                    // Atualiza Mensagem
                    await supabase.from('messages').update({
                        media_url: driveRes.data.webViewLink,
                        content: (msg.content || '') + '\n\n[Arquivo movido para Lixeira Wancora por antiguidade]'
                    }).eq('id', msg.id);

                } catch (innerError) {
                    console.error("Erro processando arquivo individual:", innerError);
                }
            }
        }
    } catch (e) {
        console.error("❌ [RETENTION] Erro fatal:", e);
    }
};

// Inicia o cron (Roda toda madrugada as 03:00)
export const startRetentionWorker = () => {
    cron.schedule('0 3 * * *', processRetention);
};
