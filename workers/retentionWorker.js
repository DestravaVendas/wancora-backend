
import cron from 'node-cron';
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedClient } from '../services/google/authService.js';
import { google } from 'googleapis';
import { Readable } from 'stream';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Helper recursivo para garantir pastas
const getFolderId = async (drive, parentId, folderName) => {
    const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false and '${parentId || 'root'}' in parents`;
    const res = await drive.files.list({ q, fields: 'files(id)' });
    
    if (res.data.files.length > 0) return res.data.files[0].id;
    
    const meta = { 
        name: folderName, 
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : []
    };
    const createRes = await drive.files.create({ resource: meta, fields: 'id' });
    return createRes.data.id;
};

const processRetention = async () => {
    console.log("♻️ [LIFECYCLE] Iniciando ciclo de retenção de mídia...");
    
    try {
        const { data: companies } = await supabase.from('companies').select('id, storage_retention_days').eq('status', 'active');
        if (!companies) return;

        for (const company of companies) {
            const retentionDays = company.storage_retention_days || 30;
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
            
            // Busca mensagens antigas que ainda estão no Supabase Storage
            const { data: msgs } = await supabase
                .from('messages')
                .select('id, media_url, message_type, content, created_at')
                .eq('company_id', company.id)
                .lte('created_at', cutoffDate.toISOString())
                .ilike('media_url', '%supabase.co%') // Garante que é local
                .limit(20); 

            if (!msgs || msgs.length === 0) continue;

            console.log(`♻️ [LIFECYCLE] Processando ${msgs.length} arquivos antigos da empresa ${company.id}`);

            // Tenta obter conexão com Google Drive
            let drive = null;
            let folders = null;
            
            try {
                const auth = await getAuthenticatedClient(company.id);
                drive = google.drive({ version: 'v3', auth });
                
                // Se conectou, prepara pastas
                const rootId = await getFolderId(drive, null, 'Lixeira Wancora (Arquivo)');
                folders = {
                    audio: await getFolderId(drive, rootId, 'Áudios WhatsApp'),
                    media: await getFolderId(drive, rootId, 'Mídias WhatsApp'),
                    files: await getFolderId(drive, rootId, 'Arquivos WhatsApp')
                };
            } catch (e) {
                // Sem drive conectado = Modo Destrutivo (Limpeza de espaço)
                // console.warn(`⚠️ [LIFECYCLE] Empresa ${company.id} sem Drive conectado. Arquivos serão apagados permanentemente.`);
            }

            for (const msg of msgs) {
                try {
                    // Extrai caminho do storage
                    const urlParts = msg.media_url.split('/chat-media/');
                    if (urlParts.length < 2) continue;
                    const storagePath = urlParts[1];

                    // 1. Se tem Drive, faz Upload
                    if (drive && folders) {
                        const { data: blob, error } = await supabase.storage.from('chat-media').download(storagePath);
                        
                        if (!error) {
                            let targetFolderId = folders.files;
                            if (msg.message_type === 'audio' || msg.message_type === 'ptt') targetFolderId = folders.audio;
                            else if (msg.message_type === 'image' || msg.message_type === 'video') targetFolderId = folders.media;

                            const ext = blob.type.split('/')[1] || 'bin';
                            const fileName = `Wancora_${msg.message_type}_${msg.id.split('-')[0]}_${new Date(msg.created_at).toISOString().split('T')[0]}.${ext}`;

                            const buffer = Buffer.from(await blob.arrayBuffer());
                            const stream = new Readable();
                            stream.push(buffer);
                            stream.push(null);

                            const driveRes = await drive.files.create({
                                resource: { name: fileName, parents: [targetFolderId] },
                                media: { mimeType: blob.type, body: stream },
                                fields: 'webViewLink'
                            });

                            // Atualiza com link do Drive
                            await supabase.from('messages').update({
                                media_url: driveRes.data.webViewLink,
                                content: (msg.content || '') + `\n\n[Arquivado no Google Drive em ${new Date().toLocaleDateString()}]`
                            }).eq('id', msg.id);
                        }
                    } else {
                        // 2. Se NÃO tem Drive, apenas marca como expirado
                        await supabase.from('messages').update({
                            media_url: null, // Remove URL para não quebrar UI
                            content: (msg.content || '') + `\n\n🚫 [Arquivo expirou e foi removido em ${new Date().toLocaleDateString()} (Sem backup configurado)]`
                        }).eq('id', msg.id);
                    }

                    // 3. SEMPRE deleta do Supabase (objetivo é economizar espaço)
                    await supabase.storage.from('chat-media').remove([storagePath]);

                } catch (innerError) {
                    console.error(`Erro arquivo ${msg.id}:`, innerError.message);
                }
            }
        }
    } catch (e) {
        console.error("❌ [LIFECYCLE] Erro fatal:", e);
    }
};

export const startRetentionWorker = () => {
    // Roda as 04:00 AM
    cron.schedule('0 4 * * *', processRetention);
};
