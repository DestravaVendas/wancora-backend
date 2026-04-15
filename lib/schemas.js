
import { z } from 'zod';

export const MessageSendSchema = z.object({
    sessionId: z.string().min(1, "Session ID obrigatório"),
    companyId: z.string().uuid("Company ID inválido"),
    to: z.string().min(8, "Número de telefone inválido"),

    // Tipo da mensagem — inclui sticker, product e pix como cidadãos de primeira classe
    type: z.enum([
        'text', 'image', 'video', 'audio', 'document',
        'poll', 'location', 'contact', 'sticker', 'product', 'card', 'pix'
    ]),

    // --- Campos de conteúdo base ---
    text: z.string().optional(),
    url: z.string().optional(),        // URL pública OU base64 da mídia
    caption: z.string().optional(),

    // --- Campos de mídia avançados ---
    /** ID do arquivo no Google Drive (UUID interno do drive_cache) ou Google File ID */
    driveFileId: z.string().optional(),
    /** Força o áudio a ser enviado como nota de voz (PTT). Requer type='audio'. */
    ptt: z.boolean().optional(),
    /** Nome do arquivo para mensagens do tipo 'document' */
    fileName: z.string().optional(),

    // --- Payload estruturado: enquete ---
    poll: z.object({
        name: z.string().min(1, "Nome da enquete obrigatório"),
        options: z.array(z.string().min(1)).min(2, "Mínimo 2 opções"),
        selectableOptionsCount: z.number().int().min(1).optional()
    }).optional(),

    // --- Payload estruturado: produto (WhatsApp Business) ---
    product: z.object({
        productId: z.string().min(1, "Product ID obrigatório"),
        title: z.string().optional(),
        description: z.string().optional(),
        currencyCode: z.string().length(3).optional(), // ISO 4217 ex: "BRL"
        priceAmount1000: z.number().int().optional(),  // Preço * 1000 (centavos × 10)
        productImageCount: z.number().int().min(0).optional()
    }).optional(),

    // --- Payload estruturado: card (Rich Link / Ad Reply) ---
    card: z.object({
        title: z.string().min(1, "Título do card obrigatório"),
        description: z.string().optional(),
        link: z.string().url("Link do card inválido"),
        thumbnailUrl: z.string().url("URL da thumbnail inválida").optional()
    }).optional()

}).refine(data => {
    // 'text' exige o campo text
    if (data.type === 'text' && !data.text) return false;

    // Mídias exigem 'url' OU 'driveFileId' como fonte de dados
    const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'];
    if (mediaTypes.includes(data.type) && !data.url && !data.driveFileId) return false;

    // 'ptt: true' só faz sentido com type='audio'
    if (data.ptt === true && data.type !== 'audio') return false;

    // Tipos estruturados exigem seus objetos
    if (data.type === 'product' && !data.product) return false;
    if (data.type === 'card' && !data.card) return false;

    // 'pix' exige a chave PIX no campo url
    if (data.type === 'pix' && !data.url) return false;

    return true;
}, {
    message: "Payload inválido para o tipo de mensagem escolhido (verifique: url/driveFileId para mídias, text para texto, ptt apenas com audio)",
    path: ["type"]
});
