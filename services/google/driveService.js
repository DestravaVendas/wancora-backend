
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

    const q = `name contains '${query}' and trashed = false`;
    
    const res = await drive.files.list({
        q: q,
        fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, size, parents, createdTime)',
        pageSize: 20
    });

    return res.data.files || [];
};

// --- IMPORTAÇÃO ---
export const importFilesToCache = async (companyId, files, targetParentId = null) => {
    if (!files || files.length === 0) return;

    // Normaliza 'null' string para null real
    const finalParentId = (targetParentId === 'null' || !targetParentId) ? null : targetParentId;

    const rows = files.map(f => ({
        company_id: companyId,
        google_id: f.id,
        name: f.name,
        mime_type: f.mimeType,
        web_view_link: f.webViewLink,
        thumbnail_link: f.thumbnailLink,
        size: f.size ? parseInt(f.size) : 0,
        parent_id: finalParentId, 
        is_folder: f.mimeType === 'application/vnd.google-apps.folder',
        created_at: f.createdTime || new Date(),
        updated_at: new Date()
    }));

    await supabase.from('drive_cache').upsert(rows, { onConflict: 'company_id, google_id' });
    return rows.length;
};

export const createFolder = async (companyId, name, parentId = null) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    let q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
    
    // Se for Lixeira, o parentId é ignorado pois ela fica na raiz, mas a função createFolder é genérica
    if (parentId) q += ` and '${parentId}' in parents`;
    else q += ` and 'root' in parents`;

    const existing = await drive.files.list({ q, fields: 'files(id, name, webViewLink)' });
    
    if (existing.data.files.length > 0) {
        const folder = existing.data.files[0];
        // Atualiza cache
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

    const fileMetadata = {
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : []
    };

    const res = await drive.files.create({
        resource: fileMetadata,
        fields: 'id, name, webViewLink, mimeType'
    });

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

// --- ESVAZIAR LIXEIRA (Deleta conteúdo da pasta Wancora) ---
export const emptyTrash = async (companyId) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });
    
    // 1. Pega ID da pasta lixeira
    const trashFolderId = await getOrCreateWancoraTrashFolder(drive);
    
    // 2. Lista tudo que está dentro dela
    const q = `'${trashFolderId}' in parents and trashed = false`;
    let res = await drive.files.list({ q, fields: 'files(id)' });
    let files = res.data.files;
    
    // 3. Deleta (Move para lixeira do sistema do Google, que deleta em 30 dias, ou deleta permanentemente)
    // Aqui vamos deletar permanentemente conforme "Esvaziar" sugere
    for (const f of files) {
        try {
            await drive.files.delete({ fileId: f.id });
        } catch (e) {
            console.error(`Erro ao apagar arquivo ${f.id} da lixeira:`, e.message);
        }
    }
    
    return { success: true };
};

// --- SYNC PRINCIPAL (MODIFICADO PARA LIXEIRA PERSONALIZADA) ---
export const syncDriveFiles = async (companyId, folderId = null, isTrash = false) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    let q = "";
    let actualParentId = folderId;

    if (isTrash) {
        // Se for modo lixeira, buscamos a pasta especial
        const trashFolderId = await getOrCreateWancoraTrashFolder(drive);
        q = `'${trashFolderId}' in parents and trashed = false`;
        // Não definimos actualParentId aqui pois a lixeira não deve salvar cache na estrutura normal
    } else {
        q = "trashed = false";
        if (folderId) {
            q += ` and '${folderId}' in parents`;
        } else {
             q += ` and 'root' in parents`; 
        }
    }

    try {
        const res = await drive.files.list({
            q: q,
            fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, size, parents, createdTime, modifiedTime, trashed)',
            orderBy: 'folder,name',
            pageSize: 1000 
        });

        const liveFiles = res.data.files || [];
        
        // Se for Lixeira, retorna direto (Live View)
        if (isTrash) {
             return liveFiles.map(f => ({
                id: f.id, 
                google_id: f.id,
                name: f.name,
                mime_type: f.mimeType,
                web_view_link: f.webViewLink,
                thumbnail_link: f.thumbnailLink,
                size: f.size ? parseInt(f.size) : 0,
                is_folder: f.mimeType === 'application/vnd.google-apps.folder',
                created_at: f.createdTime,
                updated_at: f.modifiedTime
            }));
        }
        
        // --- SYNC NORMAL (CACHE + GHOST KILLER) ---
        
        // 1. Identifica IDs vivos
        const liveIds = new Set(liveFiles.map(f => f.id));
        
        // 2. Busca IDs no Banco para esta pasta
        let dbQuery = supabase.from('drive_cache').select('google_id').eq('company_id', companyId);
        if (actualParentId) dbQuery = dbQuery.eq('parent_id', actualParentId);
        else dbQuery = dbQuery.is('parent_id', null);
        
        const { data: dbFiles } = await dbQuery;
        
        // 3. Remove Fantasmas (Estão no banco mas não no Google)
        if (dbFiles) {
            const idsToDelete = dbFiles
                .filter(dbf => !liveIds.has(dbf.google_id))
                .map(dbf => dbf.google_id);

            if (idsToDelete.length > 0) {
                console.log(`🧹 [SYNC] Removendo ${idsToDelete.length} fantasmas.`);
                await supabase.from('drive_cache').delete().eq('company_id', companyId).in('google_id', idsToDelete);
            }
        }

        // 4. Upsert Vivos
        if (liveFiles.length > 0) {
            const rows = liveFiles.map(f => ({
                company_id: companyId,
                google_id: f.id,
                name: f.name,
                mime_type: f.mimeType,
                web_view_link: f.webViewLink,
                thumbnail_link: f.thumbnailLink,
                size: f.size ? parseInt(f.size) : 0,
                parent_id: actualParentId,
                is_folder: f.mimeType === 'application/vnd.google-apps.folder',
                created_at: f.createdTime,
                updated_at: new Date()
            }));
            await supabase.from('drive_cache').upsert(rows, { onConflict: 'company_id, google_id' });
        }
        
        return liveFiles;

    } catch (e) {
        console.error("Erro syncDriveFiles:", e);
        return [];
    }
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
        is_folder: false,
        updated_at: new Date()
    });

    return res.data;
};

// ... (Resto das funções mantidas)
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
