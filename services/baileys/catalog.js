
import { sessions } from './connection.js';
import { createClient } from "@supabase/supabase-js";
import { normalizeJid } from '../crm/sync.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const fetchCatalog = async (sessionId, companyId) => {
    const session = sessions.get(sessionId);
    if (!session?.sock) throw new Error("Sessão desconectada.");

    const myJid = normalizeJid(session.sock.user?.id);

    try {
        // Busca produtos da própria conta
        const result = await session.sock.getProducts(myJid);
        
        if (result && result.products) {
            const products = result.products;
            
            // Salva no banco (Cache)
            for (const p of products) {
                const productData = {
                    company_id: companyId,
                    product_id: p.productId,
                    name: p.title,
                    description: p.description,
                    price: p.priceAmount1000 ? (p.priceAmount1000 / 1000) : 0,
                    currency: p.currencyCode,
                    image_url: p.mediaUrl, // Cuidado: URLs do WA expiram. Ideal seria baixar.
                    is_hidden: p.isHidden
                };

                await supabase.from('products').upsert(productData, { onConflict: 'company_id, product_id' });
            }
            
            return { count: products.length, products };
        }
        
        return { count: 0, products: [] };

    } catch (e) {
        console.error("Erro ao buscar catálogo:", e);
        throw new Error("Falha ao sincronizar catálogo. Verifique se é uma conta Business.");
    }
};
