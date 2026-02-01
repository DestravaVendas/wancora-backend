
import { google } from 'googleapis';
import { getAuthenticatedClient } from './authService.js';
import { createClient } from "@supabase/supabase-js";
import { Readable } from 'stream';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

/**
 * Sincroniza metadados do Drive com o Banco (Cache)
 */
export const syncDriveFiles = async (companyId, folderId = null) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    // Query: Não na lixeira e dentro da pasta (ou root se null)
    let q = "trashed=false";
    if (folderId) {
        q += ` and '${folderId}' in parents`;
    }

    const res = await drive.files.list({
        q: q,
        fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, size, parents)',
        orderBy: 'folder,name',
        pageSize: 100 // Paginação futura se necessário
    });

    const files = res.data.files;
    
    // Bulk Upsert no Cache
    if (files && files.length > 0) {
        const rows = files.map(f => ({
            company_id: companyId,
            google_id: f.id,
            name: f.name,
            mime_type: f.mimeType,
            web_view_link: f.webViewLink,
            thumbnail_link: f.thumbnailLink,
            size: f.size ? parseInt(f.size) : 0,
            parent_id: f.parents ? f.parents[0] : null,
            is_folder: f.mimeType === 'application/vnd.google-apps.folder',
            updated_at: new Date()
        }));

        await supabase.from('drive_cache').upsert(rows, { onConflict: 'company_id, google_id' });
    }

    return files;
};

/**
 * Upload de Buffer (vinda do WhatsApp) para o Drive
 */
export const uploadFile = async (companyId, buffer, fileName, mimeType, folderId = null) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    const fileMetadata = {
        name: fileName,
        parents: folderId ? [folderId] : []
    };

    const media = {
        mimeType: mimeType,
        body: stream
    };

    const res = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name, webViewLink, mimeType'
    });
    
    // Adiciona ao cache imediatamente
    await supabase.from('drive_cache').insert({
        company_id: companyId,
        google_id: res.data.id,
        name: res.data.name,
        mime_type: res.data.mimeType,
        web_view_link: res.data.webViewLink,
        parent_id: folderId
    });

    return res.data;
};

/**
 * Gera um Stream de leitura do arquivo (Para enviar no WhatsApp)
 */
export const getFileStream = async (companyId, fileId) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    // Busca metadados para saber mimetype
    const meta = await drive.files.get({ fileId, fields: 'name, mimeType, size' });
    
    // Download como stream
    const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
    );

    return {
        stream: res.data,
        fileName: meta.data.name,
        mimeType: meta.data.mimeType,
        size: meta.data.size
    };
};
