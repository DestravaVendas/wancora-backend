
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
    const q = `name contains '${safeQuery}' and trashed = false`;
    
    const res = await drive.files.list({
        q: q,
        fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, size, parents, createdTime)',
        pageSize: 20
    });

    return res.data.files || [];
};

// --- IMPORTAÇÃO (CRIAÇÃO DE ATALHOS + INSERT IMEDIATO) ---
export const importFilesToCache = async (companyId, files, targetParentId = null) => {
    console.log(`🔍 [DEBUG] Iniciando importFilesToCache. TargetParent: ${targetParentId}, Arquivos: ${files?.length}`);

    if (!files || files.length === 0) return 0;

    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });
    
    const googleParentId = (targetParentId === 'null' || !targetParentId) ? 'root' : targetParentId;
    // IMPORTANTE: Se for root, dbParentId DEVE ser null para bater com a query de listagem
    const dbParentId = (targetParentId === 'null' || !targetParentId) ? null : targetParentId;

    console.log(`🔍 [DEBUG] Parent ID resolvido -> Google: ${googleParentId}, DB: ${dbParentId}`);

    let successCount = 0;
    const recordsToInsert = [];

    for (const file of files) {
        try {
            console.log(`🔍 [DEBUG] Criando atalho para: ${file.name} (${file.id})`);
            
            // Cria o ATALHO no Google Drive
            const res = await drive.files.create({
                resource: {
                    name: file.name,
                    mimeType: 'application/vnd.google-apps.shortcut',
                    parents: [googleParentId],
                    shortcutDetails: {
                        targetId: file.id 
                    }
                },
                fields: 'id, name, mimeType, webViewLink, thumbnailLink, size, createdTime, shortcutDetails'
            });

            const shortcut = res.data;
            console.log(`✅ [DEBUG] Atalho criado no Google. ID: ${shortcut.id}`);

            // Determina o MIME type real para exibição
            const displayMime = shortcut.shortcutDetails?.targetMimeType || shortcut.mimeType;

            const newRecord = {
                company_id: companyId,
                google_id: shortcut.id, // ID do ATALHO
                name: shortcut.name,
                mime_type: displayMime,
                web_view_link: shortcut.webViewLink,
                thumbnail_link: file.thumbnailLink || null,
                size: file.size ? parseInt(file.size) : 0,
                parent_id: dbParentId, 
                is_folder: displayMime === 'application/vnd.google-apps.folder',
                created_at: shortcut.createdTime || new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            recordsToInsert.push(newRecord);
            successCount++;
        } catch (e) {
            console.error(`❌ [DEBUG] Erro ao criar atalho para ${file.name}:`, e.message);
            if (e.response) console.error('Response data:', e.response.data);
        }
    }

    if (recordsToInsert.length > 0) {
        console.log(`🔍 [DEBUG] Tentando inserir ${recordsToInsert.length} registros no Supabase...`);
        const { error, data } = await supabase.from('drive_cache').upsert(recordsToInsert, { onConflict: 'company_id, google_id' }).select();
        
        if (error) {
            console.error(`❌ [DEBUG] ERRO CRÍTICO AO SALVAR NO BANCO:`, error);
        } else {
            console.log(`✅ [DEBUG] Salvo no banco com sucesso. Registros retornados:`, data?.length);
        }
    } else {
        console.warn(`⚠️ [DEBUG] Nada para salvar no banco.`);
    }

    return successCount;
};

export const createFolder = async (companyId, name, parentId = null) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    let q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`;
    if (parentId) q += ` and '${parentId}' in parents`;
    else q += ` and 'root' in parents`;

    const existing = await drive.files.list({ q, fields: 'files(id, name, webViewLink, mimeType, createdTime)' });
    
    if (existing.data.files.length > 0) {
        const folder = existing.data.files[0];
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
        fields: 'id, name, webViewLink, mimeType, createdTime'
    });

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
    // console.log(`🔄 [SYNC] Iniciando. Folder: ${folderId}, Trash: ${isTrash}`);
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    let q = "";
    let actualParentId = folderId;

    if (isTrash) {
        const trashFolderId = await getOrCreateWancoraTrashFolder(drive);
        q = `'${trashFolderId}' in parents and trashed = false`;
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
            fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, size, parents, createdTime, modifiedTime, trashed, shortcutDetails)',
            orderBy: 'folder,name',
            pageSize: 1000 
        });

        const liveFiles = res.data.files || [];
        
        if (isTrash) {
             return liveFiles.map(f => ({
                id: f.id, 
                google_id: f.id,
                name: f.name,
                mime_type: f.shortcutDetails?.targetMimeType || f.mimeType,
                web_view_link: f.webViewLink,
                thumbnail_link: f.thumbnailLink,
                size: f.size ? parseInt(f.size) : 0,
                is_folder: (f.shortcutDetails?.targetMimeType || f.mimeType) === 'application/vnd.google-apps.folder',
                created_at: f.createdTime,
                updated_at: f.modifiedTime
            }));
        }
        
        // --- SYNC (CACHE + GHOST KILLER INTELIGENTE) ---
        const liveIds = new Set(liveFiles.map(f => f.id));
        
        let dbQuery = supabase.from('drive_cache').select('google_id, updated_at').eq('company_id', companyId);
        if (actualParentId) dbQuery = dbQuery.eq('parent_id', actualParentId);
        else dbQuery = dbQuery.is('parent_id', null);
        
        const { data: dbFiles } = await dbQuery;
        
        // PERÍODO DE GRAÇA
        const GRACE_PERIOD_MS = 180000; // 3 minutos

        if (dbFiles) {
            const idsToDelete = dbFiles
                .filter(dbf => {
                    const isMissingInGoogle = !liveIds.has(dbf.google_id);
                    if (!isMissingInGoogle) return false;

                    const lastUpdate = new Date(dbf.updated_at).getTime();
                    const age = Date.now() - lastUpdate;
                    
                    // Log de diagnóstico para o Fantasma
                    // console.log(`👻 [GHOST CHECK] File ${dbf.google_id} missing in Google. Age: ${age}ms. Grace: ${GRACE_PERIOD_MS}ms`);

                    // Só deleta se for antigo o suficiente
                    return age > GRACE_PERIOD_MS;
                })
                .map(dbf => dbf.google_id);

            if (idsToDelete.length > 0) {
                console.log(`🧹 [SYNC] Deletando ${idsToDelete.length} arquivos que não existem mais no Google (e passaram do período de graça).`);
                await supabase.from('drive_cache').delete().eq('company_id', companyId).in('google_id', idsToDelete);
            }
        }

        // Upsert Vivos
        if (liveFiles.length > 0) {
            const rows = liveFiles.map(f => {
                const displayMime = f.shortcutDetails?.targetMimeType || f.mimeType;
                return {
                    company_id: companyId,
                    google_id: f.id,
                    name: f.name,
                    mime_type: displayMime,
                    web_view_link: f.webViewLink,
                    thumbnail_link: f.thumbnailLink,
                    size: f.size ? parseInt(f.size) : 0,
                    parent_id: actualParentId,
                    is_folder: displayMime === 'application/vnd.google-apps.folder',
                    created_at: f.createdTime,
                    updated_at: new Date()
                };
            });
            await supabase.from('drive_cache').upsert(rows, { onConflict: 'company_id, google_id' });
        }
        
        return liveFiles;

    } catch (e) {
        console.error("❌ [SYNC ERROR]", e);
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
        fields: 'id, name, webViewLink, mimeType, thumbnailLink, size, createdTime'
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
        created_at: res.data.createdTime || new Date(),
        updated_at: new Date()
    });

    return res.data;
};

// ... Resto das funções
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
