
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { sendMessage } from "../baileys/sender.js";
import { getSessionId } from "../../controllers/whatsappController.js";
import { scheduleMeeting, handoffAndReport } from "../ai/agentTools.js";
import { Logger } from "../../utils/logger.js";
import axios from 'axios';

// Cliente Supabase Service Role (Realtime)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Mapa para evitar respostas duplicadas (Debounce)
const processingLock = new Set();
// Cache de clientes IA
const aiInstances = new Map();

/**
 * Definição das Ferramentas (Functions) para o Gemini
 */
const SENIOR_TOOLS = [
    {
        name: "search_files",
        description: "Busca arquivos técnicos, catálogos ou documentos no Google Drive da empresa.",
        parameters: {
            type: "OBJECT",
            properties: {
                query: { type: "STRING", description: "Termo de busca (ex: 'tabela preços', 'manual')." }
            },
            required: ["query"]
        }
    },
    {
        name: "send_file",
        description: "Envia um arquivo do Drive para o cliente.",
        parameters: {
            type: "OBJECT",
            properties: {
                google_id: { type: "STRING", description: "ID do arquivo encontrado na busca." }
            },
            required: ["google_id"]
        }
    },
    {
        name: "schedule_meeting",
        description: "Agenda uma reunião ou compromisso no calendário do CRM.",
        parameters: {
            type: "OBJECT",
            properties: {
                title: { type: "STRING", description: "Título do evento." },
                dateISO: { type: "STRING", description: "Data e hora no formato ISO 8601 (YYYY-MM-DDTHH:mm:ss)." },
                description: { type: "STRING", description: "Detalhes do agendamento." }
            },
            required: ["title", "dateISO"]
        }
    },
    {
        name: "transfer_to_human",
        description: "Transfere o atendimento para um humano e envia um relatório. Use se o cliente pedir humano, estiver muito irritado ou se a negociação fugir da sua alçada.",
        parameters: {
            type: "OBJECT",
            properties: {
                summary: { type: "STRING", description: "Resumo do que foi conversado até agora." },
                reason: { type: "STRING", description: "Motivo da transferência." }
            },
            required: ["summary", "reason"]
        }
    }
];

const getAIClient = (apiKey) => {
    if (!apiKey) return null;
    if (!aiInstances.has(apiKey)) {
        aiInstances.set(apiKey, new GoogleGenAI({ apiKey }));
    }
    return aiInstances.get(apiKey);
};

// --- ALGORITMO DE SELEÇÃO DE AGENTE (THE BRAIN) ---
const matchAgent = (content, lead, lastMsgDate, agents) => {
    if (!agents || agents.length === 0) return { agent: null, reason: 'no_agents' };

    const cleanContent = content ? content.trim().toLowerCase() : '';
    
    // 1. PALAVRA-CHAVE EXATA (Alta Prioridade)
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
    // Só ativa se o lead já estiver nesta etapa específica
    const stageMatch = agents.find(a => 
        a.trigger_config?.type === 'pipeline_stage' && 
        a.trigger_config.stage_id === lead.pipeline_stage_id
    );
    if (stageMatch) return { agent: stageMatch, reason: `pipeline_stage: ${lead.pipeline_stage_id}` };

    // Cálculo de Tempo para Gatilhos Temporais
    const hasHistory = !!lastMsgDate;
    const hoursSinceLast = hasHistory ? (Date.now() - new Date(lastMsgDate).getTime()) / (1000 * 60 * 60) : 99999;

    // 4. PRIMEIRA MENSAGEM DA VIDA (Boas Vindas)
    // Se não tem histórico anterior (lastMsgDate é null), é a primeira vez
    if (!hasHistory) {
        const firstEver = agents.find(a => a.trigger_config?.type === 'first_message_ever');
        if (firstEver) return { agent: firstEver, reason: 'first_message_ever' };
    }

    // 5. PRIMEIRA MENSAGEM DO DIA (Retorno)
    // Se passou mais de 24h desde a última mensagem
    if (hoursSinceLast >= 24) {
        const firstDay = agents.find(a => a.trigger_config?.type === 'first_message_day');
        if (firstDay) return { agent: firstDay, reason: 'first_message_day' };
    }

    // 6. SENTINELA PADRÃO (DEFAULT)
    // Pega o marcado como default ou o que tiver 'all_messages'
    const defaultAgent = agents.find(a => a.is_default) || agents.find(a => a.trigger_config?.type === 'all_messages');
    
    if (defaultAgent) return { agent: defaultAgent, reason: 'default_fallback' };

    return { agent: null, reason: 'no_match_found' };
};

const processAIResponse = async (payload) => {
    const { id, content, remote_jid, company_id, from_me, message_type, media_url, transcription, created_at } = payload.new;

    if (from_me) return;
    
    // Ignora grupos e newsletters
    if (remote_jid.includes('@g.us') || remote_jid.includes('@newsletter')) return;

    // Horizonte de Eventos (2 min) - Evita responder mensagens muito antigas em sync
    const msgTime = new Date(created_at).getTime();
    if (Date.now() - msgTime > 2 * 60 * 1000) return;

    // Debounce
    const lockKey = `${remote_jid}-${id}`;
    if (processingLock.has(lockKey)) return;
    processingLock.add(lockKey);
    setTimeout(() => processingLock.delete(lockKey), 10000);

    // --- 1. Resolução do Lead e Status ---
    const phone = remote_jid.split('@')[0];
    const { data: lead } = await supabase
        .from('leads')
        .select('id, name, bot_status, owner_id, pipeline_stage_id')
        .eq('company_id', company_id)
        .eq('phone', phone)
        .maybeSingle();

    if (!lead || lead.bot_status !== 'active') return;

    // --- 2. Input Unificado ---
    let userMessage = content;
    if ((message_type === 'audio' || message_type === 'ptt') && transcription) {
        userMessage = `[Áudio Transcrito]: ${transcription}`;
    } else if (message_type === 'image') {
        userMessage = `[Imagem Enviada] ${content || ''}`;
    }
    
    if (!userMessage) return;

    // --- 3. Busca Contextual (Agentes + Histórico Recente) ---
    // Buscamos TUDO em paralelo para performance
    const [agentsRes, companyRes, historyRes] = await Promise.all([
        supabase.from('agents').select('*').eq('company_id', company_id).eq('is_active', true),
        supabase.from('companies').select('ai_config').eq('id', company_id).single(),
        supabase.from('messages')
            .select('created_at')
            .eq('company_id', company_id)
            .eq('remote_jid', remote_jid)
            .eq('from_me', false) // Mensagens do cliente
            .neq('id', id) // Exclui a atual
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
    ]);

    const activeAgents = agentsRes.data || [];
    const lastMsgDate = historyRes.data?.created_at || null;
    const companyConfig = companyRes.data?.ai_config;

    // --- 4. O CÉREBRO: Escolha do Agente ---
    const { agent, reason } = matchAgent(userMessage, lead, lastMsgDate, activeAgents);

    if (!agent) {
        // Se nenhum agente assumiu, loga como Info e encerra silenciosamente
        // Logger.info('sentinel', `Nenhum agente elegível para ${phone}`, { reason }, company_id);
        return;
    }

    // Log de Decisão (Auditabilidade)
    Logger.info('sentinel', `Agente Selecionado: ${agent.name}`, { 
        lead: phone, 
        trigger: reason, 
        agent_level: agent.level 
    }, company_id);

    try {
        let activeApiKey = companyConfig?.apiKey || process.env.API_KEY;
        let activeModel = 'gemini-3-flash-preview'; 
        if (agent.level === 'senior') activeModel = 'gemini-3-pro-preview';
        if (companyConfig?.model) activeModel = companyConfig.model; 

        const ai = getAIClient(activeApiKey);
        if (!ai) return;

        // --- 5. Contexto de Conversa ---
        let contextLimit = 5; 
        if (agent.level === 'pleno') contextLimit = 12;
        if (agent.level === 'senior') contextLimit = 30;

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

        // --- 6. Prompt Engineering ---
        const filesKnowledge = agent.knowledge_config?.text_files?.map(f => `Arquivo: ${f.name} - Link: ${f.url}`).join('\n') || '';
        
        // [NOVO] Injection de Links
        const availableLinks = agent.links_config?.map(l => `Link para "${l.title}": ${l.url}`).join('\n') || '';

        // Regras de Personalidade (Arrays)
        const negativeList = agent.personality_config?.negative_prompts?.map(p => `- EVITE: ${p}`).join('\n') || '';
        const escapeList = agent.personality_config?.escape_rules?.map(p => `- REGRA DE ESCAPE: ${p}`).join('\n') || '';

        let systemInstruction = `
        VOCÊ É: ${agent.name}, um assistente nível ${agent.level.toUpperCase()} da empresa.
        
        SUA MISSÃO:
        ${agent.prompt_instruction}
        
        CONTEXTO DO CLIENTE:
        Nome: ${lead.name || 'Não identificado'}
        Telefone: ${phone}
        
        BASE DE CONHECIMENTO (ARQUIVOS):
        ${filesKnowledge}
        
        LINKS ÚTEIS DISPONÍVEIS (Use quando o cliente pedir):
        ${availableLinks}
        
        DIRETRIZES DE PERSONALIDADE:
        Papel: ${agent.personality_config?.role || 'Atendente'}
        Tom: ${agent.personality_config?.tone || 'Profissional'}
        Contexto Empresa: ${agent.personality_config?.context || ''}

        RESTRIÇÕES & REGRAS:
        ${negativeList}
        ${escapeList}
        `;

        if (agent.level === 'junior') {
            systemInstruction += `
            - Responda de forma curta e direta.
            - Se não souber, peça para aguardar um humano.
            - Não invente informações.`;
        } else if (agent.level === 'pleno') {
            systemInstruction += `
            - Use técnicas de venda e persuasão.
            - Tente contornar objeções simples.
            - Use as informações dos arquivos para responder dúvidas.`;
        } else if (agent.level === 'senior') {
            systemInstruction += `
            - Você é um especialista autônomo.
            - Pode agendar reuniões e buscar arquivos no Drive se necessário.
            - INOVAÇÃO: Analise o sentimento do cliente. Se ele estiver muito irritado ou agressivo, use a ferramenta 'transfer_to_human' imediatamente.
            - Use formatação rica (*negrito*, listas) para melhor leitura.`;
        }

        const fullContents = [...chatHistory, { role: 'user', parts: [{ text: userMessage }] }];

        // --- 7. Execução com Ferramentas (Sênior) ---
        const toolsConfig = agent.level === 'senior' ? { 
            tools: [{ functionDeclarations: SENIOR_TOOLS }]
        } : {};

        let response = await ai.models.generateContent({
            model: activeModel,
            contents: fullContents,
            config: {
                systemInstruction: systemInstruction,
                temperature: agent.level === 'senior' ? 0.5 : 0.7, 
                ...toolsConfig
            }
        });

        // --- 8. Loop de Ferramentas ---
        let toolResponse = response;
        let functionCalls = toolResponse.functionCalls;
        let loopLimit = 0; 
        let finalReply = "";

        while (functionCalls && functionCalls.length > 0 && loopLimit < 3) {
            loopLimit++;
            const parts = [];

            for (const call of functionCalls) {
                console.log(`🤖 [AGENTE ${agent.level}] Executando ferramenta: ${call.name}`);
                let result = {};

                try {
                    if (call.name === 'search_files') {
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
                    else if (call.name === 'schedule_meeting') {
                        result = await scheduleMeeting(
                            company_id, 
                            lead.id, 
                            call.args.title, 
                            call.args.dateISO, 
                            call.args.description, 
                            lead.owner_id
                        );
                    }
                    else if (call.name === 'transfer_to_human') {
                        const reportingPhones = agent.tools_config?.reporting_phones || [];
                        result = await handoffAndReport(
                            company_id, 
                            lead.id, 
                            remote_jid, 
                            call.args.summary, 
                            call.args.reason,
                            reportingPhones
                        );
                        // Se transferiu, paramos o loop e não respondemos mais nada (o handoff já mandou msg)
                        return;
                    }
                } catch (toolError) {
                    console.error(`⚠️ [AI TOOL ERROR] ${call.name}:`, toolError);
                    result = { error: toolError.message };
                }

                parts.push({
                    functionResponse: {
                        name: call.name,
                        response: { result: result }
                    }
                });
            }

            fullContents.push({ role: "model", parts: toolResponse.candidates[0].content.parts });
            fullContents.push({ role: "function", parts: parts });

            toolResponse = await ai.models.generateContent({
                model: activeModel,
                contents: fullContents,
                config: { systemInstruction, temperature: 0.5, ...toolsConfig }
            });
            
            functionCalls = toolResponse.functionCalls;
        }

        finalReply = toolResponse.text;
        
        // --- 9. Envio da Resposta ---
        if (finalReply) {
            const sessionId = await getSessionId(company_id);
            if (sessionId) {
                // Pequeno delay "humano" baseado no tamanho
                await new Promise(r => setTimeout(r, Math.min(finalReply.length * 30, 2000)));
                
                await sendMessage({
                    sessionId,
                    to: remote_jid,
                    type: 'text',
                    content: finalReply
                });
            }
        }

    } catch (error) {
        Logger.error('sentinel', `Erro Fatal na IA`, { error: error.message, stack: error.stack }, company_id);
    }
};

export const startSentinel = () => {
    console.log("🛡️ [SENTINEL] Cérebro da IA Iniciado (Multi-Nível & Trigger-Based).");
    supabase
        .channel('ai-sentinel-global')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, processAIResponse)
        .subscribe();
};
