import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai"; // IMPORTAÇÃO ADICIONADA: SchemaType
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

// --- DEFINIÇÃO DE TOOLS (SDK ESTÁVEL - CORRIGIDO) ---
// É OBRIGATÓRIO usar SchemaType em vez de strings soltas.
const ALL_TOOLS = [
    {
        name: "transfer_to_human",
        description: "Transfere para humano. Use se cliente pedir, estiver irritado ou o assunto for complexo demais.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                summary: { type: SchemaType.STRING, description: "Resumo da conversa até agora." },
                reason: { type: SchemaType.STRING, description: "Motivo da transferência." }
            },
            required: ["summary", "reason"]
        }
    },
    {
        name: "search_files",
        description: "Busca arquivos ou documentos no Google Drive da empresa para responder dúvidas.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                query: { type: SchemaType.STRING, description: "Termo de busca do arquivo." }
            },
            required: ["query"]
        }
    },
    {
        name: "send_file",
        description: "Envia um arquivo encontrado no Drive para o cliente.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                google_id: { type: SchemaType.STRING, description: "ID do arquivo no Google Drive (obtido via search_files)." }
            },
            required: ["google_id"]
        }
    },
    {
        name: "schedule_meeting",
        description: "Agenda uma reunião no calendário.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                title: { type: SchemaType.STRING, description: "Título do evento." },
                dateISO: { type: SchemaType.STRING, description: "Data e hora ISO 8601 (YYYY-MM-DDTHH:mm:ss)." },
                description: { type: SchemaType.STRING, description: "Detalhes do agendamento." }
            },
            required: ["title", "dateISO"]
        }
    }
];

// Factory com tratamento de erro
const getAIClient = (apiKey) => {
    if (!apiKey || apiKey.trim().length < 10) return null;
    
    if (!aiInstances.has(apiKey)) {
        try {
            const instance = new GoogleGenerativeAI(apiKey);
            aiInstances.set(apiKey, instance);
        } catch (e) {
            console.error("❌ [SENTINEL] Erro ao instanciar GoogleGenerativeAI:", e.message);
            return null;
        }
    }
    return aiInstances.get(apiKey);
};

const matchAgent = (content, lead, lastMsgDate, agents) => {
    if (!agents || agents.length === 0) return { agent: null, reason: 'no_agents_configured' };
    const cleanContent = content ? content.trim().toLowerCase() : '';
    
    const exactMatch = agents.find(a => a.trigger_config?.type === 'keyword_exact' && a.trigger_config.keywords?.some(k => k.toLowerCase() === cleanContent));
    if (exactMatch) return { agent: exactMatch, reason: `keyword_exact: "${cleanContent}"` };

    const containsMatch = agents.find(a => a.trigger_config?.type === 'keyword_contains' && a.trigger_config.keywords?.some(k => cleanContent.includes(k.toLowerCase())));
    if (containsMatch) return { agent: containsMatch, reason: `keyword_contains` };

    const stageMatch = agents.find(a => a.trigger_config?.type === 'pipeline_stage' && a.trigger_config.stage_id === lead.pipeline_stage_id);
    if (stageMatch) return { agent: stageMatch, reason: `pipeline_stage: ${lead.pipeline_stage_id}` };

    const hasHistory = !!lastMsgDate;
    
    if (!hasHistory) {
        const firstEver = agents.find(a => a.trigger_config?.type === 'first_message_ever');
        if (firstEver) return { agent: firstEver, reason: 'first_message_ever' };
    }

    const hoursSinceLast = hasHistory ? (Date.now() - new Date(lastMsgDate).getTime()) / (1000 * 60 * 60) : 99999;
    if (hoursSinceLast >= 24) {
        const firstDay = agents.find(a => a.trigger_config?.type === 'first_message_day');
        if (firstDay) return { agent: firstDay, reason: 'first_message_day' };
    }

    const defaultAgent = agents.find(a => a.is_default) || agents.find(a => a.trigger_config?.type === 'all_messages');
    if (defaultAgent) return { agent: defaultAgent, reason: 'default_fallback' };

    return { agent: null, reason: 'no_match_found' };
};

const processAIResponse = async (payload) => {
    if (!payload.new) return;
    const { id, content, remote_jid, company_id, from_me, message_type, transcription, created_at } = payload.new;

    if (from_me) return;
    if (remote_jid.includes('@g.us') || remote_jid.includes('@newsletter')) return;
    if (remote_jid === '0@s.whatsapp.net' || remote_jid === '12345678@broadcast') return;

    const msgTime = new Date(created_at).getTime();
    if ((Date.now() - msgTime) / 1000 > 180) return; 

    const lockKey = `${remote_jid}-${id}`;
    if (processingLock.has(lockKey)) return;
    processingLock.add(lockKey);
    setTimeout(() => processingLock.delete(lockKey), 15000);

    const phone = remote_jid.split('@')[0];
    const { data: lead } = await supabase.from('leads').select('id, name, bot_status, owner_id, pipeline_stage_id').eq('company_id', company_id).ilike('phone', `%${phone}%`).maybeSingle();

    if (!lead || lead.bot_status !== 'active') return;

    let userMessage = content;
    if ((message_type === 'audio' || message_type === 'ptt') && transcription) {
        userMessage = `[Áudio Transcrito]: ${transcription}`;
    } else if (message_type === 'image') {
        userMessage = `[Imagem Enviada]`;
    }
    
    if (!userMessage) return;

    const [agentsRes, companyRes, historyRes] = await Promise.all([
        supabase.from('agents').select('*').eq('company_id', company_id).eq('is_active', true),
        supabase.from('companies').select('ai_config').eq('id', company_id).single(),
        supabase.from('messages').select('created_at').eq('company_id', company_id).eq('remote_jid', remote_jid).eq('from_me', false).neq('id', id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    ]);

    const activeAgents = agentsRes.data || [];
    const lastMsgDate = historyRes.data?.created_at || null;
    const companyConfig = companyRes.data?.ai_config;

    const { agent, reason } = matchAgent(userMessage, lead, lastMsgDate, activeAgents);
    if (!agent) return;

    Logger.info('sentinel', `Agente: ${agent.name}`, { lead: phone, trigger: reason }, company_id);

    try {
        let activeApiKey = companyConfig?.apiKey || process.env.API_KEY; // <-- MESMO PONTO DE ATENÇÃO DO TRANSCRIBER: Verifique se no .env é API_KEY ou GEMINI_API_KEY
        if (!activeApiKey) return;

        // MODEL FALLBACK: Força 2.5 Flash se tentar usar 1.5 problemático
        let activeModel = 'gemini-2.5-flash';
        if (companyConfig?.model && !companyConfig.model.includes('1.5')) {
             activeModel = companyConfig.model;
        }

        const genAI = getAIClient(activeApiKey);
        if (!genAI) return;

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

        let systemInstruction = buildSystemPrompt(agent);
        const filesKnowledge = agent.knowledge_config?.text_files?.map(f => `Arquivo: ${f.name} - Link: ${f.url}`).join('\n') || '';
        systemInstruction += `\n[CONTEXTO ATUAL]\nCliente: ${lead.name}\nData: ${new Date().toLocaleString('pt-BR')}\n${filesKnowledge}`;

        let toolsConfig = [];
        if (agent.level === 'senior') {
            toolsConfig = [{ functionDeclarations: ALL_TOOLS }];
        } else {
             toolsConfig = [{ functionDeclarations: ALL_TOOLS.filter(t => t.name === 'transfer_to_human') }];
        }

        const model = genAI.getGenerativeModel({ 
            model: activeModel,
            systemInstruction,
            tools: toolsConfig // Passando as ferramentas configuradas corretamente
        });

        const chat = model.startChat({
            history: chatHistory,
            generationConfig: {
                temperature: 0.5,
                maxOutputTokens: 1000
            }
        });

        console.log(`🧠 [SENTINEL] Enviando para ${activeModel}...`);

        let result = await chat.sendMessage(userMessage);
        let response = result.response;
        let functionCalls = response.functionCalls();
        let loopLimit = 0;

        // Loop de tratamento de Tools (Até 3 chamadas seguidas)
        while (functionCalls && functionCalls.length > 0 && loopLimit < 3) {
            loopLimit++;
            const toolResults = [];

            for (const call of functionCalls) {
                console.log(`🛠️ Executando Tool: ${call.name}`);
                let output = {};

                try {
                    if (call.name === 'schedule_meeting') {
                        output = await scheduleMeeting(company_id, lead.id, call.args.title, call.args.dateISO, call.args.description, lead.owner_id);
                    }
                    else if (call.name === 'transfer_to_human') {
                        const reportingPhones = agent.tools_config?.reporting_phones || [];
                        await handoffAndReport(company_id, lead.id, remote_jid, call.args.summary, call.args.reason, reportingPhones);
                        return; // Encerra a IA aqui, humano assumiu
                    }
                    else if (call.name === 'search_files') {
                        const { data: files } = await supabase.rpc('search_drive_files', { 
                            p_company_id: company_id, 
                            p_query: call.args.query,
                            p_limit: 5,
                            p_folder_id: agent.tools_config?.drive_folder_id || null
                        });
                        output = { found: true, files: files || [] };
                    } 
                    else if (call.name === 'send_file') {
                        const sessionId = await getSessionId(company_id);
                        if (sessionId) {
                            sendMessage({
                                sessionId,
                                to: remote_jid,
                                driveFileId: call.args.google_id,
                                companyId
                            }).catch(() => {});
                            output = { success: true, message: "Arquivo enviado." };
                        }
                    }
                } catch (toolError) {
                    output = { error: toolError.message };
                }

                toolResults.push({
                    functionResponse: {
                        name: call.name,
                        response: output
                    }
                });
            }

            // Devolve o resultado da tool para o modelo pensar no que falar
            result = await chat.sendMessage(toolResults);
            response = result.response;
            functionCalls = response.functionCalls();
        }

        const finalReply = response.text();

        if (finalReply) {
            const sessionId = await getSessionId(company_id);
            if (sessionId) {
                const timingConfig = agent.flow_config?.timing;
                await sendMessage({
                    sessionId,
                    to: remote_jid,
                    type: 'text',
                    content: finalReply,
                    timingConfig,
                    companyId
                });
            }
        }

    } catch (error) {
        if (error.message?.includes('404')) {
             Logger.error('sentinel', `Erro Fatal IA: Modelo Inexistente`, { details: "API Key não tem acesso ao modelo." }, company_id); // Corrigido companyId minúsculo aqui
        } else if (!error.message?.includes('SAFETY')) {
            Logger.error('sentinel', `Erro Fatal na IA`, { error: error.message }, company_id);
        }
    }
};

export const startSentinel = () => {
    console.log("🛡️ [SENTINEL] IA Monitorando (Model: Gemini 2.5 Flash)...");
    supabase
        .channel('ai-sentinel-global')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, processAIResponse)
        .subscribe();
};
