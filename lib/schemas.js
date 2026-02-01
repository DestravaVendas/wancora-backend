
import { z } from 'zod';

export const MessageSendSchema = z.object({
    sessionId: z.string().min(1, "Session ID obrigatório"),
    companyId: z.string().uuid("Company ID inválido"),
    to: z.string().min(8, "Número de telefone inválido"),
    type: z.enum(['text', 'image', 'video', 'audio', 'document', 'poll', 'location', 'contact', 'sticker', 'product', 'card']),
    text: z.string().optional(),
    url: z.string().optional(),
    caption: z.string().optional(),
    poll: z.object({
        name: z.string().min(1),
        options: z.array(z.string()).min(2),
        selectableOptionsCount: z.number().optional()
    }).optional(),
    product: z.object({
        productId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        currencyCode: z.string().optional(),
        priceAmount1000: z.number().optional(),
        productImageCount: z.number().optional()
    }).optional(),
    // Dados para o Card (Rich Link)
    card: z.object({
        title: z.string(),
        description: z.string().optional(),
        link: z.string().url("Link inválido"),
        thumbnailUrl: z.string().url().optional()
    }).optional()
}).refine(data => {
    // Validação condicional
    if (data.type === 'text' && !data.text) return false;
    if (['image', 'video', 'audio', 'sticker'].includes(data.type) && !data.url) return false;
    if (data.type === 'product' && !data.product) return false;
    if (data.type === 'card' && !data.card) return false;
    return true;
}, {
    message: "Payload inválido para o tipo de mensagem escolhido",
    path: ["type"]
});
