
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { sendMessage } from "../baileys/sender.js";
import { getSessionId } from "../../controllers/whatsappController.js";

// Cliente Supabase Service Role (Realtime)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Mapa para evitar respostas duplicadas em curto prazo (Debounce)
const processingLock = new Set();

// Cache de clientes IA para evitar recriar a cada mensagem
// Key: apiKey, Value: GoogleGenAI Instance
const aiInstances = new Map();

/**
 * Factory Dinâmica de IA
 * Instancia ou recupera um cliente Gemini baseado na chave fornecida.
 */
const getAIClient = (apiKey) => {
    if (!apiKey) return null;
    if (!aiInstances.has(apiKey)) {
        // console.log("⚡ [SENTINEL] Instanciando novo cliente Gemini (BYOK).");
        aiInstances.set(apiKey, new GoogleGenAI({ apiKey }));
    }
    return aiInstances.get(apiKey);
};

const processAIResponse = async (payload) => {
    const { id, content, remote_jid, company_id, from_me, message_type } = payload.new;

    // 1. Filtros de Segurança Básicos
    if (from_me) return; // Não responde a si mesmo
    if (message_type !== 'text') return; // MVP: Apenas texto
    if (!content) return;

    // Debounce: Evita processar a mesma mensagem duas vezes
    const lockKey = `${remote_jid}-${id}`;
    if (processingLock.has(lockKey)) return;
    processingLock.add(lockKey);
    setTimeout(() => processingLock.delete(lockKey), 10000); // Libera memória

    // 2. Verificar se o Lead existe e tem Bot Ativo
    const phone = remote_jid.split('@')[0];
    const { data: lead } = await supabase
        .from('leads')
        .select('id, name, bot_status')
        .eq('company_id', company_id)
        .eq('phone', phone)
        .maybeSingle();

    if (!lead || lead.bot_status !== 'active') return;

    // 3. Buscar Configuração do Agente E Configuração da Empresa (Chaves)
    // Fazemos um Promise.all para otimizar tempo
    const [agentRes, companyRes] = await Promise.all([
        supabase.from('agents').select('*').eq('company_id', company_id).eq('is_active', true).maybeSingle(),
        supabase.from('companies').select('ai_config').eq('id', company_id).single()
    ]);

    const agent = agentRes.data;
    const companyConfig = companyRes.data?.ai_config;

    if (!agent) return; // Se não tem agente configurado, não faz nada

    try {
        console.log(`🤖 [SENTINEL] IA Acionada para ${lead.name} (${phone})...`);

        // RESOLUÇÃO DE API KEY (BYOK Logic)
        // 1. Tenta a chave da empresa
        // 2. Fallback para a chave do sistema (.env)
        let activeApiKey = companyConfig?.apiKey || process.env.API_KEY;
        let activeModel = companyConfig?.model || agent.model || 'gemini-3-flash-preview';

        if (!activeApiKey) {
            console.error("❌ [SENTINEL] Erro: Nenhuma API Key encontrada (Nem empresa, nem sistema).");
            return;
        }

        const ai = getAIClient(activeApiKey);

        // 4. Carregar Contexto (Histórico Recente)
        const { data: history } = await supabase
            .from('messages')
            .select('content, from_me')
            .eq('company_id', company_id)
            .eq('remote_jid', remote_jid)
            .order('created_at', { ascending: false })
            .limit(10); // Contexto das últimas 10 mensagens

        // Formata histórico para o Gemini (Do mais antigo para o mais novo)
        const chatHistory = (history || []).reverse().map(m => ({
            role: m.from_me ? 'model' : 'user',
            parts: [{ text: m.content || "" }]
        }));

        // 5. Montagem do Prompt de Sistema
        const systemInstruction = `
        ${agent.prompt_instruction}
        
        INFORMAÇÕES DO CLIENTE ATUAL:
        Nome: ${lead.name}
        Telefone: ${lead.phone}
        
        BASE DE CONHECIMENTO DA EMPRESA:
        ${agent.knowledge_base}
        
        DIRETRIZES TÉCNICAS:
        - Responda APENAS com o texto da mensagem. Sem JSON, sem markdown excessivo.
        - Mantenha o tom natural de WhatsApp (pode usar emojis, seja breve).
        - Se não souber a resposta com base no conhecimento fornecido, diga que vai chamar um humano.
        `;

        // 6. Geração da Resposta
        const response = await ai.models.generateContent({
            model: activeModel,
            contents: chatHistory,
            config: {
                systemInstruction: systemInstruction,
                maxOutputTokens: 300, // Limite seguro
                temperature: 0.7 // Criatividade moderada
            }
        });

        const replyText = response.text;

        if (replyText) {
            // 7. Envio da Resposta
            const sessionId = await getSessionId(company_id);
            if (sessionId) {
                // Pequeno delay "thinking" para parecer humano (Humanização)
                await new Promise(r => setTimeout(r, 2000));
                
                await sendMessage({
                    sessionId,
                    to: remote_jid,
                    type: 'text',
                    content: replyText
                });
                console.log(`✅ [SENTINEL] Resposta enviada para ${lead.name}.`);
            }
        }

    } catch (error) {
        console.error("❌ [SENTINEL] Erro na geração de resposta IA:", error.message);
    }
};

export const startSentinel = () => {
    console.log("🛡️ [SENTINEL] Agente de IA iniciado (BYOK Enabled). Monitorando canal 'messages'...");
    
    // Inicia listener do Supabase Realtime
    supabase
        .channel('ai-sentinel-global')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, processAIResponse)
        .subscribe();
};
