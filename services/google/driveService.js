
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

// --- IMPORTAÇÃO ( REFERÊNCIA VIRTUAL ) ---
// Agora APENAS salva no banco. Não cria atalho no Google Drive.
export const importFilesToCache = async (companyId, files, targetParentId = null) => {
    if (!files || files.length === 0) return 0;

    // Resolve o parent_id para o banco de dados
    // Se targetParentId for 'null' string, null object ou undefined, vira NULL no banco (Raiz do Wancora)
    const dbParentId = (targetParentId === 'null' || !targetParentId) ? null : targetParentId;

    let successCount = 0;
    const recordsToInsert = [];

    for (const file of files) {
        try {
            // Prepara o registro para o banco Wancora
            // Usamos o ID real do arquivo do Google.
            const newRecord = {
                company_id: companyId,
                google_id: file.id, // ID Original
                name: file.name,
                mime_type: file.mimeType,
                web_view_link: file.webViewLink,
                thumbnail_link: file.thumbnailLink || null,
                size: file.size ? parseInt(file.size) : 0,
                parent_id: dbParentId, // Coloca na pasta atual do Wancora (Virtualmente)
                is_folder: file.mimeType === 'application/vnd.google-apps.folder',
                created_at: file.createdTime || new Date(),
                updated_at: new Date() 
            };

            recordsToInsert.push(newRecord);
            successCount++;
        } catch (e) {
            console.error(`Erro ao preparar importação de ${file.name}:`, e.message);
        }
    }

    if (recordsToInsert.length > 0) {
        // Upsert: Se já existir (mesmo ID na mesma empresa), atualiza a pasta (move virtualmente)
        // Isso previne duplicatas de 5 cópias. O arquivo só pode estar em um lugar no Wancora por vez.
        const { error } = await supabase.from('drive_cache').upsert(recordsToInsert, { 
            onConflict: 'company_id, google_id' 
        });

        if (error) {
            console.error("Erro ao salvar no banco:", error.message);
        }
    }

    return successCount;
};

export const createFolder = async (companyId, name, parentId = null) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    // Se tiver parentId no Wancora, precisamos saber qual é o ID real no Google.
    // Mas como estamos trabalhando com estrutura virtual, é mais seguro criar na Raiz do Google
    // ou tentar achar a pasta pai se ela também estiver sincronizada.
    // Simplificação: Cria na raiz do Google, mas organiza visualmente no Wancora.
    // Para consistência total, o ideal é criar na raiz do Google Drive para não perder o arquivo.
    
    const fileMetadata = {
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        // Se quiséssemos criar dentro de outra pasta no Google, precisaríamos do google_id do pai.
        // Por segurança, criamos na raiz ou na pasta pai se fornecida e válida.
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
        // Se falhar (ex: parentId não existe no google), cria na raiz
        delete fileMetadata.parents;
        res = await drive.files.create({
            resource: fileMetadata,
            fields: 'id, name, webViewLink, mimeType, createdTime'
        });
    }

    // Salva no Banco Wancora na pasta correta
    await supabase.from('drive_cache').insert({
        company_id: companyId,
        google_id: res.data.id,
        name: res.data.name,
        mime_type: res.data.mimeType,
        web_view_link: res.data.webViewLink,
        parent_id: parentId, // Mantém a hierarquia visual do Wancora
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
    // Apenas retorna o que está no banco para evitar sobrescrever a estrutura virtual
    // com a estrutura real do Google (que pode ser diferente).
    // O Sync com a API do Google só deve ocorrer se explicitamente solicitado ou para atualizar metadados (tamanho/nome),
    // mas NÃO para deletar arquivos que não estão na pasta exata do Google.
    
    if (isTrash) {
         // Para lixeira, sempre consultamos a API ao vivo
         const auth = await getAuthenticatedClient(companyId);
         const drive = google.drive({ version: 'v3', auth });
         const trashFolderId = await getOrCreateWancoraTrashFolder(drive);
         const q = `'${trashFolderId}' in parents and trashed = false`;
         
         const res = await drive.files.list({
            q: q,
            fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, size, parents, createdTime, modifiedTime)',
            orderBy: 'folder,name',
            pageSize: 100
        });
        
        return res.data.files || [];
    }

    // Para pastas normais, confiamos no banco de dados (Cache Virtual)
    // O "Sync" real (Ghost Killer) é perigoso aqui porque estamos misturando arquivos de várias pastas do Google
    // em uma pasta virtual do Wancora.
    
    // Então, retornamos vazio aqui e deixamos o controller ler do banco.
    // Se precisar atualizar metadados, faríamos um check individual, mas por agora, 
    // removemos a lógica de deletar coisas do banco baseado na listagem do Google.
    
    return []; 
};

export const uploadFile = async (companyId, buffer, fileName, mimeType, folderId = null) => {
    const auth = await getAuthenticatedClient(companyId);
    const drive = google.drive({ version: 'v3', auth });

    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    // Upload na raiz do Google ou na pasta específica se soubermos o ID
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
        // Fallback para raiz
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
