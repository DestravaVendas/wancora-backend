
import { createClient } from "@supabase/supabase-js";

// Cliente Supabase Service Role para validação administrativa
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const requireAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: "Token de autenticação ausente." });
        }

        const token = authHeader.split(' ')[1];
        
        // 1. Valida o Token JWT com o Supabase Auth
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            return res.status(403).json({ error: "Token inválido ou expirado." });
        }

        // 2. Anexa o usuário à requisição
        req.user = user;

        // 3. Validação de Multi-Tenant (RBAC)
        // Se a rota exige um companyId, verificamos se o usuário pertence a ela
        const requestCompanyId = req.body.companyId || req.headers['x-company-id'];

        if (requestCompanyId) {
            const { data: profile } = await supabase
                .from('profiles')
                .select('company_id, role')
                .eq('id', user.id)
                .single();

            // Regra de Ouro: Usuário só mexe na própria empresa
            if (!profile || profile.company_id !== requestCompanyId) {
                console.warn(`🚨 [SECURITY] Tentativa de acesso cruzado! User: ${user.id} -> Company: ${requestCompanyId}`);
                return res.status(403).json({ error: "Acesso negado a esta organização." });
            }
            
            // Injeta role para uso futuro nos controllers
            req.user.role = profile.role;
        }

        next();
    } catch (e) {
        console.error("❌ [AUTH MIDDLEWARE] Erro:", e);
        return res.status(500).json({ error: "Erro interno de autenticação." });
    }
};
