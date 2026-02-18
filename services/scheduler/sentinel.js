
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { sendMessage } from "../baileys/sender.js";
import { getSessionId } from "../../controllers/whatsappController.js";
import { scheduleMeeting, handoffAndReport } from "../ai/agentTools.js";
import { Logger } from "../../utils/logger.js";
import { buildSystemPrompt } from "../../utils/promptBuilder.js"; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const processingLock = new Set();
const aiInstances = new Map();

/**
 * Funções de Ferramentas (Tools)
 */
const TRANSFER_TOOL = {
    name: "transfer_to_human",
    description: "Transfere para humano. Use se cliente pedir ou estiver irritado.",
    parameters: {
        type: "OBJECT",
        properties: {
            summary: { type: "STRING", description: "Resumo da conversa." },
            reason: { type: "STRING", description: "Motivo." }
        },
        required: ["summary", "reason"]
    }
};

const ADVANCED_TOOLS = [
    {
        name: "search_files",
        description: "Busca arquivos no Google Drive da empresa.",
        parameters: {
            type: "OBJECT",
            properties: {
                query: { type: "STRING", description: "Termo de busca." }
            },
            required: ["query"]
        }
    },
    {
        name: "send_file",
        description: "Envia arquivo do Drive.",
        parameters: {
            type: "OBJECT",
            properties: {
                google_id: { type: "STRING", description: "ID do arquivo." }
            },
            required: ["google_id"]
        }
    },
    {
        name: "schedule_meeting",
        description: "Agenda reunião no calendário.",
        parameters: {
            type: "OBJECT",
            properties: {
                title: { type: "STRING", description: "Título." },
                dateISO: { type: "STRING", description: "Data ISO 8601 (YYYY-MM-DDTHH:mm:ss)." },
                description: { type: "STRING", description: "Detalhes." }
            },
            required: ["title", "dateISO"]
        }
    }
];

const getAIClient = (apiKey) => {
    if (!apiKey) return null;
    if (!aiInstances.has(apiKey)) {
        console.log(`[SENTINEL] Novo cliente Gemini inicializado.`);
        aiInstances.set(apiKey, new GoogleGenAI({ apiKey }));
    }
    return aiInstances.get(apiKey);
};

// --- HELPER DE RETRY (Blindagem contra 503) ---
const generateContentWithRetry = async (aiModel, params, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await aiModel.generateContent(params);
        } catch (error) {
            const isOverloaded = error.message?.includes('503') || error.message?.includes('Overloaded') || error.status === 503;
            
            if (isOverloaded && i < retries - 1) {
                const delay = 2000 * Math.pow(2, i);
                console.warn(`⚠️ [GEMINI] 503 Overload. Tentativa ${i + 1}/${retries} em ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw error;
        }
    }
};

const matchAgent = (content, lead, lastMsgDate, agents) => {
    if (!agents || agents.length === 0) return { agent: null, reason: 'no_agents_configured' };

    const cleanContent = content ? content.trim().toLowerCase() : '';
    
    // 1. PALAVRA-CHAVE EXATA
    const exactMatch = agents.find(a => 
        a.trigger_config?.type === 'keyword_exact' && 
        a.trigger_config.keywords?.some(k => k.toLowerCase() === cleanContent)
    );
    if (exactMatch) return { agent: exactMatch, reason: `keyword_exact: "${cleanContent}"` };

    // 2. CONTÉM PALAVRA-CHAVE
    const containsMatch = agents.find(a => 
        a.trigger_config?.type === 'keyword_contains' && 
        a.trigger_config.keywords?.some(k => cleanContent.includes(k.toLowerCase()))
    );
    if (containsMatch) return { agent: containsMatch, reason: `keyword_contains` };

    // 3. ESTÁGIO DO FUNIL
    const stageMatch = agents.find(a => 
        a.trigger_config?.type === 'pipeline_stage' && 
        a.trigger_config.stage_id === lead.pipeline_stage_id
    );
    if (stageMatch) return { agent: stageMatch, reason: `pipeline_stage: ${lead.pipeline_stage_id}` };

    // Lógica de Tempo
    const hasHistory = !!lastMsgDate;
    const hoursSinceLast = hasHistory ? (Date.now() - new Date(lastMsgDate).getTime()) / (1000 * 60 * 60) : 99999;

    // 4. PRIMEIRA MENSAGEM DA VIDA
    if (!hasHistory) {
        const firstEver = agents.find(a => a.trigger_config?.type === 'first_message_ever');
        if (firstEver) return { agent: firstEver, reason: 'first_message_ever' };
    }

    // 5. PRIMEIRA MENSAGEM DO DIA
    if (hoursSinceLast >= 24) {
        const firstDay = agents.find(a => a.trigger_config?.type === 'first_message_day');
        if (firstDay) return { agent: firstDay, reason: 'first_message_day' };
    }

    // 6. SENTINELA PADRÃO
    const defaultAgent = agents.find(a => a.is_default) || agents.find(a => a.trigger_config?.type === 'all_messages');
    
    if (defaultAgent) return { agent: defaultAgent, reason: 'default_fallback' };

    return { agent: null, reason: 'no_match_found' };
};

const processAIResponse = async (payload) => {
    // Log de diagnóstico para provar que o evento chegou
    console.log(`📡 [SENTINEL] Evento recebido no banco! ID: ${payload.new?.id}`);

    if (!payload.new) return;
    const { id, content, remote_jid, company_id, from_me, message_type, transcription, created_at } = payload.new;

    // [GUARDIÃO 1] Ignora minhas próprias mensagens, grupos e sistema oficial do WhatsApp
    if (from_me) return;
    if (remote_jid.includes('@g.us') || remote_jid.includes('@newsletter')) return;
    if (remote_jid === '0@s.whatsapp.net' || remote_jid === '12345678@broadcast') {
        console.log(`🛡️ [SENTINEL] Ignorando mensagem de sistema (WhatsApp Oficial/Broadcast).`);
        return;
    }

    // [GUARDIÃO 2] CRONÔMETRO DE SEGURANÇA (CRÍTICO)
    const msgTime = new Date(created_at).getTime();
    const now = Date.now();
    const ageInSeconds = (now - msgTime) / 1000;

    if (ageInSeconds > 120) { 
        if (ageInSeconds < 600) { 
             console.log(`🛡️ [SENTINEL] Ignorando mensagem antiga/histórico (${Math.round(ageInSeconds)}s atrás): ${remote_jid}`);
        }
        return;
    }

    console.log(`🔍 [SENTINEL] Processando mensagem recente (${Math.round(ageInSeconds)}s): ${remote_jid}`);

    // Debounce
    const lockKey = `${remote_jid}-${id}`;
    if (processingLock.has(lockKey)) return;
    processingLock.add(lockKey);
    setTimeout(() => processingLock.delete(lockKey), 10000);

    // [TRACE 2] Buscando Lead
    const phone = remote_jid.split('@')[0];
    const { data: lead, error: leadError } = await supabase
        .from('leads')
        .select('id, name, bot_status, owner_id, pipeline_stage_id')
        .eq('company_id', company_id)
        .ilike('phone', `%${phone}%`) 
        .maybeSingle();

    if (leadError) {
        console.error(`❌ [SENTINEL] Erro ao buscar lead:`, leadError);
        return;
    }

    if (!lead) {
        console.log(`⚠️ [SENTINEL] Lead não encontrado para ${phone}. (Lead Guard não criou ainda?)`);
        return;
    }

    if (lead.bot_status !== 'active') {
        console.log(`⏸️ [SENTINEL] Bot pausado para ${lead.name}. Status: ${lead.bot_status}`);
        return;
    }

    let userMessage = content;
    if ((message_type === 'audio' || message_type === 'ptt') && transcription) {
        userMessage = `[Áudio Transcrito]: ${transcription}`;
    } else if (message_type === 'image') {
        userMessage = `[Imagem Enviada] ${content || ''}`;
    }
    
    if (!userMessage) {
        console.log(`⚠️ [SENTINEL] Mensagem sem conteúdo processável.`);
        return;
    }

    // [TRACE 3] Buscando Agentes
    const [agentsRes, companyRes, historyRes] = await Promise.all([
        supabase.from('agents').select('*').eq('company_id', company_id).eq('is_active', true),
        supabase.from('companies').select('ai_config').eq('id', company_id).single(),
        supabase.from('messages')
            .select('created_at')
            .eq('company_id', company_id)
            .eq('remote_jid', remote_jid)
            .eq('from_me', false)
            .neq('id', id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
    ]);

    const activeAgents = agentsRes.data || [];
    const lastMsgDate = historyRes.data?.created_at || null;
    const companyConfig = companyRes.data?.ai_config;

    console.log(`ℹ️ [SENTINEL] Agentes ativos encontrados: ${activeAgents.length}`);

    const { agent, reason } = matchAgent(userMessage, lead, lastMsgDate, activeAgents);

    if (!agent) {
         console.log(`⚠️ [SENTINEL] Nenhum agente deu match. Motivo: ${reason}`);
         return;
    }

    Logger.info('sentinel', `Agente Selecionado: ${agent.name}`, { lead: phone, trigger: reason }, company_id);

    try {
        // [TRACE 4] Configuração de API
        let activeApiKey = companyConfig?.apiKey || process.env.API_KEY;
        if (!activeApiKey) {
             console.error(`❌ [SENTINEL] FALHA CRÍTICA: Sem API Key para empresa ${company_id}.`);
             return;
        }

        // --- MODELO PADRÃO COMERCIAL: GEMINI 1.5 FLASH ---
        // Se o usuário configurar manualmente algo diferente no banco, respeita.
        // Mas o padrão do sistema agora é 1.5 Flash para tudo.
        let activeModel = 'gemini-1.5-flash'; 
        if (companyConfig?.model) activeModel = companyConfig.model; 

        console.log(`🤖 [SENTINEL] Inicializando Gemini com modelo: ${activeModel}`);

        const ai = getAIClient(activeApiKey);
        if (!ai) return;

        // Contexto
        let contextLimit = agent.level === 'senior' ? 20 : 6;
        const { data: chatHistoryData } = await supabase
            .from('messages')
            .select('content, from_me, message_type, transcription')
            .eq('company_id', company_id)
            .eq('remote_jid', remote_jid)
            .neq('id', id)
            .order('created_at', { ascending: false })
            .limit(contextLimit);

        const chatHistory = (chatHistoryData || []).reverse().map(m => {
            let txt = m.content || "";
            if ((m.message_type === 'audio' || m.message_type === 'ptt') && m.transcription) {
                txt = `[Áudio]: ${m.transcription}`;
            }
            return {
                role: m.from_me ? 'model' : 'user',
                parts: [{ text: txt }]
            };
        });

        // Prompt
        let systemInstruction = buildSystemPrompt(agent);

        const filesKnowledge = agent.knowledge_config?.text_files?.map(f => `Arquivo: ${f.name} - Link: ${f.url}`).join('\n') || '';
        const availableLinks = agent.links_config?.map(l => `Link para "${l.title}": ${l.url}`).join('\n') || '';

        systemInstruction += `
        
        [CONTEXTO ATUAL]
        Cliente: ${lead.name || 'Não identificado'}
        Telefone: ${phone}
        Hoje: ${new Date().toLocaleString('pt-BR')}
        
        [CONHECIMENTO ADICIONAL]
        ${filesKnowledge}
        
        [LINKS ÚTEIS]
        ${availableLinks}
        `;
        
        // Safety para Junior
        if (agent.level === 'junior') {
            systemInstruction += `\n[NÍVEL JUNIOR] Se não souber, use a ferramenta 'transfer_to_human'.`;
        }

        const fullContents = [...chatHistory, { role: 'user', parts: [{ text: userMessage }] }];

        let tools = [TRANSFER_TOOL];
        if (agent.level === 'senior') tools = [...tools, ...ADVANCED_TOOLS];

        const toolsConfig = { tools: [{ functionDeclarations: tools }] };

        // [TRACE 5] Geração com Retry
        console.log(`🧠 [SENTINEL] Enviando prompt para Gemini (${activeModel})...`);
        let response;
        try {
            response = await generateContentWithRetry(ai.models, {
                model: activeModel,
                contents: fullContents,
                config: {
                    systemInstruction,
                    temperature: agent.level === 'senior' ? 0.5 : 0.7, 
                    maxOutputTokens: 8192, 
                    ...toolsConfig
                }
            });
        } catch (genError) {
             console.error(`❌ [AI ERROR] Falha na geração Gemini:`, genError.message);
             Logger.error('sentinel', 'Erro Gemini API', { error: genError.message }, company_id);
             return;
        }

        // Tools Handling
        let toolResponse = response;
        let functionCalls = toolResponse.functionCalls;
        let loopLimit = 0; 
        let finalReply = "";

        while (functionCalls && functionCalls.length > 0 && loopLimit < 3) {
            loopLimit++;
            const parts = [];

            for (const call of functionCalls) {
                console.log(`🛠️ [SENTINEL] Executando Tool: ${call.name}`);
                let result = {};

                try {
                    if (call.name === 'schedule_meeting') {
                        result = await scheduleMeeting(company_id, lead.id, call.args.title, call.args.dateISO, call.args.description, lead.owner_id);
                    }
                    else if (call.name === 'transfer_to_human') {
                        const reportingPhones = agent.tools_config?.reporting_phones || [];
                        await handoffAndReport(company_id, lead.id, remote_jid, call.args.summary, call.args.reason, reportingPhones);
                        return; // Stop processing immediately
                    }
                    else if (call.name === 'search_files') {
                        const { data: files } = await supabase.rpc('search_drive_files', { 
                            p_company_id: company_id, 
                            p_query: call.args.query,
                            p_limit: 5,
                            p_folder_id: agent.tools_config?.drive_folder_id || null
                        });
                        result = { found: true, files: files || [] };
                    } 
                    else if (call.name === 'send_file') {
                        const sessionId = await getSessionId(company_id);
                        if (sessionId) {
                            sendMessage({
                                sessionId,
                                to: remote_jid,
                                driveFileId: call.args.google_id,
                                companyId
                            }).catch(err => console.error("Erro send_file:", err));
                            result = { success: true, message: "Arquivo enviado." };
                        }
                    }
                } catch (toolError) {
                    result = { error: toolError.message };
                }

                parts.push({
                    functionResponse: { name: call.name, response: { result: result } }
                });
            }

            fullContents.push({ role: "model", parts: toolResponse.candidates[0].content.parts });
            fullContents.push({ role: "function", parts: parts });

            toolResponse = await generateContentWithRetry(ai.models, {
                model: activeModel,
                contents: fullContents,
                config: { 
                    systemInstruction, 
                    temperature: 0.5, 
                    maxOutputTokens: 8192, 
                    ...toolsConfig 
                }
            });
            
            functionCalls = toolResponse.functionCalls;
        }

        finalReply = toolResponse.text;
        
        if (finalReply) {
            console.log(`📤 [SENTINEL] Resposta gerada. Enviando para WhatsApp...`);
            const sessionId = await getSessionId(company_id);
            if (sessionId) {
                const timingConfig = agent.flow_config?.timing;
                await sendMessage({
                    sessionId,
                    to: remote_jid,
                    type: 'text',
                    content: finalReply,
                    timingConfig,
                    companyId // Passa companyId para logging
                });
                console.log(`✅ [SENTINEL] Mensagem enviada com sucesso.`);
            } else {
                Logger.warn('sentinel', 'Falha ao responder: WhatsApp desconectado.', {}, company_id);
            }
        } else {
             console.warn(`⚠️ [SENTINEL] IA gerou resposta vazia.`);
        }

    } catch (error) {
        console.error(`❌ [SENTINEL] Erro Fatal:`, error);
        Logger.error('sentinel', `Erro Fatal na IA`, { error: error.message }, company_id);
    }
};

export const startSentinel = () => {
    console.log("🛡️ [SENTINEL] Cérebro da IA Iniciado (Multi-Nível & Tools).");
    supabase
        .channel('ai-sentinel-global')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, processAIResponse)
        .subscribe();
};
