
import { google } from 'googleapis';
import { getAuthenticatedClient } from './authService.js';
import { createClient } from "@supabase/supabase-js";
import { Readable } from 'stream';
import mammoth from 'mammoth'; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const getStorageQuota = async (companyId) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.about.get({ fields: 'storageQuota' });
    return res.data.storageQuota;
};

// --- HELPER: Pega ou Cria a Pasta "Lixeira Wancora" ---
const getOrCreateWancoraTrashFolder = async (drive) => {
    const q = "mimeType='application/vnd.google-apps.folder' and name='Lixeira Wancora (Arquivo)' and trashed=false and 'root' in parents";
    const res = await drive.files.list({ q, fields: 'files(id)' });
    
    if (res.data.files.length > 0) {
        return res.data.files[0].id;
    }
    
    const meta = { 
        name: 'Lixeira Wancora (Arquivo)', 
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root']
    };
    const createRes = await drive.files.create({ resource: meta, fields: 'id' });
    return createRes.data.id;
};

// --- BUSCA AO VIVO ---
export const searchLiveFiles = async (companyId, query) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    const safeQuery = query.replace(/'/g, "\\'");
    // Busca arquivos que NÃO estão na lixeira e que contêm o nome
    const q = `name contains '${safeQuery}' and trashed = false`;
    
    const res = await drive.files.list({
        q: q,
        fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, size, parents, createdTime)',
        pageSize: 20
    });

    return res.data.files || [];
};

// --- LISTAGEM REMOTA (BROWSING) ---
export const listRemoteFolder = async (companyId, folderId = 'root') => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    // Se folderId for nulo ou undefined, usa root
    const targetId = folderId || 'root';

    const q = `'${targetId}' in parents and trashed = false`;
    
    const res = await drive.files.list({
        q: q,
        fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, size, createdTime)',
        orderBy: 'folder,name',
        pageSize: 100
    });

    // Mapeia para formato padrão
    return (res.data.files || []).map(f => ({
        id: f.id,
        google_id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        mime_type: f.mimeType, // Compatibilidade
        webViewLink: f.webViewLink,
        thumbnailLink: f.thumbnailLink,
        size: f.size ? parseInt(f.size) : 0,
        is_folder: f.mimeType === 'application/vnd.google-apps.folder'
    }));
};

// --- HELPER: Recursão para buscar filhos ---
const fetchChildrenRecursively = async (drive, folderId, dbRecords, companyId) => {
    let pageToken = null;
    do {
        const q = `'${folderId}' in parents and trashed = false`;
        const res = await drive.files.list({
            q,
            fields: 'nextPageToken, files(id, name, mimeType, webViewLink, thumbnailLink, size, createdTime)',
            pageToken,
            pageSize: 1000
        });

        const files = res.data.files;
        pageToken = res.data.nextPageToken;

        for (const file of files) {
            const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
            
            dbRecords.push({
                company_id: companyId,
                google_id: file.id,
                name: file.name,
                mime_type: file.mimeType,
                web_view_link: file.webViewLink,
                thumbnail_link: file.thumbnailLink || null,
                size: file.size ? parseInt(file.size) : 0,
                parent_id: folderId, // Define o pai como a pasta atual
                is_folder: isFolder,
                created_at: file.createdTime || new Date(),
                updated_at: new Date()
            });

            if (isFolder) {
                // Se for pasta, mergulha nela
                await fetchChildrenRecursively(drive, file.id, dbRecords, companyId);
            }
        }
    } while (pageToken);
};

// --- IMPORTAÇÃO ( REFERÊNCIA VIRTUAL + RECURSÃO ) ---
export const importFilesToCache = async (companyId, files, targetParentId = null) => {
    if (!files || files.length === 0) return 0;

    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    // Resolve o parent_id para o banco de dados (Pasta onde o usuário está "soltando" a importação)
    const dbParentId = (targetParentId === 'null' || !targetParentId) ? null : targetParentId;

    const recordsToInsert = [];

    // 1. Processa os arquivos/pastas raiz da seleção
    for (const file of files) {
        try {
            const isFolder = file.mimeType === 'application/vnd.google-apps.folder';

            // Adiciona o item selecionado
            recordsToInsert.push({
                company_id: companyId,
                google_id: file.id, // ID Original
                name: file.name,
                mime_type: file.mimeType,
                web_view_link: file.webViewLink,
                thumbnail_link: file.thumbnailLink || null,
                size: file.size ? parseInt(file.size) : 0,
                parent_id: dbParentId, 
                is_folder: isFolder,
                created_at: file.createdTime || new Date(),
                updated_at: new Date() 
            });

            // Se for pasta, busca todo o conteúdo interno recursivamente
            if (isFolder) {
                await fetchChildrenRecursively(drive, file.id, recordsToInsert, companyId);
            }

        } catch (e) {
            console.error(`Erro ao preparar importação de ${file.name}:`, e.message);
        }
    }

    // 2. Upsert em Lote
    if (recordsToInsert.length > 0) {
        // Chunking para não estourar o limite do Supabase em imports gigantes
        const CHUNK_SIZE = 100;
        for (let i = 0; i < recordsToInsert.length; i += CHUNK_SIZE) {
            const chunk = recordsToInsert.slice(i, i + CHUNK_SIZE);
            const { error } = await supabase.from('drive_cache').upsert(chunk, { 
                onConflict: 'company_id, google_id' 
            });
            if (error) console.error("Erro partial upsert:", error.message);
        }
    }

    return recordsToInsert.length;
};

export const createFolder = async (companyId, name, parentId = null) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });
    
    const fileMetadata = {
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : [] 
    };

    // Tenta criar
    let res;
    try {
        res = await drive.files.create({
            resource: fileMetadata,
            fields: 'id, name, webViewLink, mimeType, createdTime'
        });
    } catch (e) {
        delete fileMetadata.parents;
        res = await drive.files.create({
            resource: fileMetadata,
            fields: 'id, name, webViewLink, mimeType, createdTime'
        });
    }

    // Salva no Banco Wancora
    await supabase.from('drive_cache').insert({
        company_id: companyId,
        google_id: res.data.id,
        name: res.data.name,
        mime_type: res.data.mimeType,
        web_view_link: res.data.webViewLink,
        parent_id: parentId, 
        is_folder: true,
        created_at: res.data.createdTime || new Date(),
        updated_at: new Date()
    });

    return res.data;
};

// Deleta do Drive REAL e do Cache
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

// REMOVE APENAS DO CACHE (Sem tocar no Google Drive)
export const removeFilesFromCache = async (companyId, fileIds) => {
    try {
        // Remove do banco
        await supabase.from('drive_cache')
            .delete()
            .eq('company_id', companyId)
            .in('google_id', fileIds);

        return { success: true };
    } catch (e) {
        console.error("Erro ao remover importação:", e);
        throw e;
    }
};

export const emptyTrash = async (companyId) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });
    
    const trashFolderId = await getOrCreateWancoraTrashFolder(drive);
    
    const q = `'${trashFolderId}' in parents and trashed = false`;
    let res = await drive.files.list({ q, fields: 'files(id)' });
    
    for (const f of res.data.files) {
        try {
            await drive.files.delete({ fileId: f.id });
        } catch (e) { }
    }
    
    return { success: true };
};

export const syncDriveFiles = async (companyId, folderId = null, isTrash = false) => {
    if (isTrash) {
         // Para lixeira, sempre consultamos a API ao vivo
         const auth = await getAuthenticatedClient(companyId);
         const drive = google.drive({ version: 'v3', auth });
         const trashFolderId = await getOrCreateWancoraTrashFolder(drive);
         const q = `'${trashFolderId}' in parents and trashed = false`;
         
         const res = await drive.files.list({
            q: q,
            fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, size, parents, createdTime, modifiedTime, shortcutDetails)',
            orderBy: 'folder,name',
            pageSize: 100
        });
        
        // Mapeamento ROBUSTO para evitar crash no frontend
        const safeFiles = (res.data.files || []).map(f => ({
            id: f.id, // ID local (usando o do Google na lixeira pois não está no banco)
            google_id: f.id,
            name: f.name,
            mime_type: f.mimeType || 'application/octet-stream', // Fallback seguro
            web_view_link: f.webViewLink || '#',
            thumbnail_link: f.thumbnailLink || null,
            size: f.size ? parseInt(f.size) : 0,
            is_folder: f.mimeType === 'application/vnd.google-apps.folder',
            created_at: f.createdTime || new Date().toISOString(),
            updated_at: f.modifiedTime || new Date().toISOString()
        }));

        return safeFiles;
    }
    return []; 
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

    let res;
    try {
        res = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, name, webViewLink, mimeType, thumbnailLink, size, createdTime'
        });
    } catch (e) {
        delete fileMetadata.parents;
        res = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, name, webViewLink, mimeType, thumbnailLink, size, createdTime'
        });
    }
    
    await supabase.from('drive_cache').insert({
        company_id: companyId,
        google_id: res.data.id,
        name: res.data.name,
        mime_type: res.data.mimeType,
        web_view_link: res.data.webViewLink,
        thumbnail_link: res.data.thumbnailLink,
        size: res.data.size ? parseInt(res.data.size) : 0,
        parent_id: folderId,
        is_folder: false,
        created_at: res.data.createdTime || new Date(),
        updated_at: new Date()
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

export const getFileBuffer = async (companyId, fileId) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    const meta = await drive.files.get({ fileId, fields: 'name, mimeType, size, webViewLink' });
    
    let res;
    let mimeType = meta.data.mimeType;

    if (mimeType.includes('application/vnd.google-apps.document')) {
        res = await drive.files.export({ fileId, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, { responseType: 'arraybuffer' });
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else if (mimeType.includes('application/vnd.google-apps.spreadsheet')) {
        res = await drive.files.export({ fileId, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, { responseType: 'arraybuffer' });
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else {
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

export const convertDocxToHtml = async (companyId, fileId) => {
    const fileData = await getFileBuffer(companyId, fileId);
    if (fileData.isLargeFile) throw new Error("Arquivo muito grande para conversão.");
    if (!fileData.mimeType.includes('wordprocessingml.document')) throw new Error("Apenas documentos Word (.docx) ou Google Docs podem ser editados.");

    const result = await mammoth.convertToHtml({ buffer: fileData.buffer });
    return {
        html: result.value,
        filename: fileData.fileName,
        messages: result.messages 
    };
};
