
import { createClient } from "@supabase/supabase-js";

// Cliente Supabase Service Role para validação administrativa
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const requireAuth = async (req, res, next) => {
    // 🔓 WHITELIST: Rotas que NÃO precisam de autenticação
    // O Callback do Google é público e vem do navegador do usuário sem headers customizados
    if (req.path.includes('/google/callback') || req.originalUrl.includes('/google/callback')) {
        console.log("🔓 [AUTH] Permitindo acesso público ao Callback Google.");
        return next();
    }

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

        // 3. Validação de Multi-Tenant (RBAC) - Fail-Closed
        // Busca sempre o perfil do usuário diretamente no banco de dados para segurança máxima
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('company_id, role')
            .eq('id', user.id)
            .maybeSingle();

        if (profileError || !profile || !profile.company_id) {
            console.warn(`🚨 [SECURITY] Usuário sem organização associada ou perfil não encontrado! User: ${user.id}`);
            return res.status(403).json({ error: "Acesso negado. Usuário sem organização vinculada." });
        }

        // Injeta empresa e role confiáveis do banco na requisição
        req.user.companyId = profile.company_id;
        req.user.role = profile.role;

        // Se o cliente forneceu companyId, este DEVE ser idêntico ao do perfil associado
        const clientCompanyId = req.body.companyId || req.query.companyId || req.headers['x-company-id'];
        if (clientCompanyId && clientCompanyId !== profile.company_id) {
            console.warn(`🚨 [SECURITY] Tentativa de acesso cruzado! User: ${user.id} -> Tentou acessar: ${clientCompanyId} | Empresa Real: ${profile.company_id}`);
            return res.status(403).json({ error: "Acesso negado a esta organização." });
        }

        next();
    } catch (e) {
        console.error("❌ [AUTH MIDDLEWARE] Erro:", e);
        return res.status(500).json({ error: "Erro interno de autenticação." });
    }
};

export const requireSessionTenant = async (req, res, next) => {
    const sessionId = req.body.sessionId || req.params.sessionId || req.query.sessionId;
    
    if (!sessionId) {
        return res.status(400).json({ error: "O parâmetro sessionId é obrigatório para esta rota." });
    }

    try {
        const companyId = req.user.companyId;

        // Verifica no banco de dados se a sessão pertence à empresa do usuário
        const { data: instance, error } = await supabase
            .from('instances')
            .select('company_id')
            .eq('session_id', sessionId)
            .maybeSingle();

        if (error || !instance) {
            console.warn(`🚨 [SECURITY] Tentativa de acesso a sessão inexistente ou inválida! User: ${req.user.id} -> Session: ${sessionId}`);
            return res.status(403).json({ error: "Sessão não autorizada ou inexistente para esta empresa." });
        }

        if (instance.company_id !== companyId) {
            console.warn(`🚨 [SECURITY] Tentativa de hijacking de sessão! User: ${req.user.id} (Empresa: ${companyId}) -> Tentou acessar Session: ${sessionId} (Empresa: ${instance.company_id})`);
            return res.status(403).json({ error: "Acesso negado. Esta sessão não pertence à sua organização." });
        }

        next();
    } catch (e) {
        console.error("❌ [SESSION TENANT MIDDLEWARE] Erro:", e);
        return res.status(500).json({ error: "Erro interno ao validar tenant da sessão." });
    }
};
