
import { google } from 'googleapis';
import { getAuthenticatedClient } from './authService.js';
import { createClient } from "@supabase/supabase-js";
import { Readable } from 'stream';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const getStorageQuota = async (companyId) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.about.get({ fields: 'storageQuota' });
    return res.data.storageQuota;
};

export const createFolder = async (companyId, name, parentId = null) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    // 1. Verifica se já existe para evitar duplicatas (Check prévio)
    let q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
    if (parentId) q += ` and '${parentId}' in parents`;
    
    const existing = await drive.files.list({ q, fields: 'files(id, name, webViewLink)' });
    
    if (existing.data.files.length > 0) {
        const folder = existing.data.files[0];
        // Garante que está no cache (Self-healing)
        await supabase.from('drive_cache').upsert({
            company_id: companyId,
            google_id: folder.id,
            name: folder.name,
            mime_type: 'application/vnd.google-apps.folder',
            web_view_link: folder.webViewLink,
            parent_id: parentId,
            is_folder: true,
            updated_at: new Date()
        }, { onConflict: 'company_id, google_id' });
        
        return folder;
    }

    // 2. Cria se não existir
    const fileMetadata = {
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : []
    };

    const res = await drive.files.create({
        resource: fileMetadata,
        fields: 'id, name, webViewLink, mimeType'
    });

    // 3. CACHE IMEDIATO (Critical Fix para Lixeira aparecer na hora)
    await supabase.from('drive_cache').insert({
        company_id: companyId,
        google_id: res.data.id,
        name: res.data.name,
        mime_type: res.data.mimeType,
        web_view_link: res.data.webViewLink,
        parent_id: parentId,
        is_folder: true,
        updated_at: new Date()
    });

    return res.data;
};

export const deleteFiles = async (companyId, fileIds) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    const promises = fileIds.map(async (fileId) => {
        try {
            await drive.files.update({
                fileId: fileId,
                requestBody: { trashed: true }
            });
            await supabase.from('drive_cache').delete().eq('google_id', fileId).eq('company_id', companyId);
        } catch (e) {
            console.error(`Erro ao deletar ${fileId}:`, e.message);
        }
    });

    await Promise.all(promises);
    return { success: true };
};

/**
 * Deep Sync: Busca TODOS os arquivos do Drive e atualiza o Cache local
 * Isso resolve o problema de arquivos "não encontrados"
 */
export const syncDriveFiles = async (companyId, folderId = null) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    // Se folderId for nulo, busca tudo que não está na lixeira para popular o banco
    // Isso garante que "Meus Arquivos" existentes apareçam
    let q = "trashed=false";
    
    if (folderId) {
        q += ` and '${folderId}' in parents`;
    } 
    // Se não tem folderId, não filtramos por parent para pegar TUDO (Deep Sync)
    // Mas cuidado com performance em drives gigantes. Para MVP é ok.

    const res = await drive.files.list({
        q: q,
        fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, size, parents, createdTime, modifiedTime)',
        orderBy: 'folder,name',
        pageSize: 1000 
    });

    const files = res.data.files;
    
    if (files && files.length > 0) {
        const rows = files.map(f => ({
            company_id: companyId,
            google_id: f.id,
            name: f.name,
            mime_type: f.mimeType,
            web_view_link: f.webViewLink,
            thumbnail_link: f.thumbnailLink,
            size: f.size ? parseInt(f.size) : 0,
            // Se parents existir, pega o primeiro. Se não, é root (null)
            parent_id: (f.parents && f.parents.length > 0) ? f.parents[0] : null,
            is_folder: f.mimeType === 'application/vnd.google-apps.folder',
            created_at: f.createdTime,
            updated_at: new Date()
        }));

        await supabase.from('drive_cache').upsert(rows, { onConflict: 'company_id, google_id' });
    }

    return files;
};

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
        fields: 'id, name, webViewLink, mimeType, thumbnailLink, size'
    });
    
    await supabase.from('drive_cache').insert({
        company_id: companyId,
        google_id: res.data.id,
        name: res.data.name,
        mime_type: res.data.mimeType,
        web_view_link: res.data.webViewLink,
        thumbnail_link: res.data.thumbnailLink,
        size: res.data.size ? parseInt(res.data.size) : 0,
        parent_id: folderId,
        is_folder: false
    });

    return res.data;
};

export const getFileStream = async (companyId, fileId) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });
    const meta = await drive.files.get({ fileId, fields: 'name, mimeType, size' });
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

    return {
        stream: res.data,
        fileName: meta.data.name,
        mimeType: meta.data.mimeType,
        size: meta.data.size
    };
};

// [NOVO] Baixa buffer para edição no Frontend
export const getFileBuffer = async (companyId, fileId) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    const meta = await drive.files.get({ fileId, fields: 'name, mimeType, size, webViewLink' });
    
    let res;
    let mimeType = meta.data.mimeType;

    // Se for Google Doc/Sheet, EXPORTA para formato editável
    if (mimeType.includes('application/vnd.google-apps.document')) {
        res = await drive.files.export({ fileId, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, { responseType: 'arraybuffer' });
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else if (mimeType.includes('application/vnd.google-apps.spreadsheet')) {
        res = await drive.files.export({ fileId, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, { responseType: 'arraybuffer' });
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else {
        // Arquivo binário normal (PDF, Imagem, Docx nativo)
        const size = parseInt(meta.data.size || '0');
        if (size > 40 * 1024 * 1024) {
            return { isLargeFile: true, link: meta.data.webViewLink, fileName: meta.data.name, mimeType };
        }
        res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    }

    return {
        isLargeFile: false,
        buffer: Buffer.from(res.data),
        fileName: meta.data.name,
        mimeType,
        size: meta.data.size
    };
};
