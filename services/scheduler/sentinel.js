import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { sendMessage } from "../baileys/sender.js";
import { getSessionId } from "../../controllers/whatsappController.js";
import { scheduleMeeting, handoffAndReport, checkAvailability } from "../ai/agentTools.js";
import { Logger } from "../../utils/logger.js";
import { buildSystemPrompt } from "../../utils/promptBuilder.js"; 

// 🛡️ FIX 1: Timeout estendido para 30 segundos (Evita o TIMED_OUT no Render)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false },
    realtime: {
        timeout: 30000 
    }
});

const processingLock = new Set();
const aiInstances = new Map();

// --- DEFINIÇÃO DE TOOLS (SDK ESTÁVEL - COMPLETO) ---
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
        name: "check_availability",
        description: "ANTES de sugerir um horário para o cliente, use esta ferramenta para consultar a agenda e ver quais horários estão OCUPADOS em uma data específica.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                dateISO: { type: SchemaType.STRING, description: "A data desejada em formato ISO 8601 (ex: 2026-02-25T00:00:00Z)." }
            },
            required: ["dateISO"]
        }
    },
    {
        name: "schedule_meeting",
        description: "Agenda uma reunião no calendário após confirmar o horário com o cliente.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                title: { type: SchemaType.STRING, description: "Título do evento." },
                dateISO: { type: SchemaType.STRING, description: "Data e hora exata acordada em formato ISO 8601 (YYYY-MM-DDTHH:mm:ss)." },
                description: { type: SchemaType.STRING, description: "Detalhes e pauta do agendamento." }
            },
            required: ["title", "dateISO"]
        }
    }
];

// Factory com tratamento de erro e Fallback Global
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
    console.log(`\n🔔 [RAIO-X] Novo evento detectado! ID:`, payload.new?.id);
    if (!payload.new) return;
    
    const { id, content, remote_jid, company_id, from_me, message_type, transcription, created_at } = payload.new;

    if (from_me) {
        console.log("   ❌ Bloqueio: Mensagem do próprio bot.");
        return;
    }
    if (remote_jid.includes('@g.us') || remote_jid.includes('@newsletter') || remote_jid === '0@s.whatsapp.net') {
        console.log("   ❌ Bloqueio: Mensagem de grupo/sistema.");
        return;
    }

    const msgTime = new Date(created_at).getTime();
    const timeDiff = (Date.now() - msgTime) / 1000;
    if (timeDiff > 180) {
        console.log(`   ❌ Bloqueio: Mensagem muito antiga (${timeDiff.toFixed(0)}s).`);
        return; 
    }

    const lockKey = `${remote_jid}-${id}`;
    if (processingLock.has(lockKey)) {
        console.log("   ❌ Bloqueio: Em processamento.");
        return;
    }
    processingLock.add(lockKey);
    setTimeout(() => processingLock.delete(lockKey), 15000);

    const phone = remote_jid.split('@')[0];
    console.log(`   🔍 Buscando Lead: ${phone}...`);
    
    const { data: lead } = await supabase.from('leads').select('id, name, bot_status, owner_id, pipeline_stage_id').eq('company_id', company_id).ilike('phone', `%${phone}%`).maybeSingle();

    if (!lead) {
        console.log("   ❌ Bloqueio: Lead não existe no banco.");
        return;
    }
    if (lead.bot_status !== 'active') {
        console.log(`   ❌ Bloqueio: Status do bot é '${lead.bot_status}'.`);
        return;
    }

    console.log(`   ✅ Lead Validado: ${lead.name}`);

    let userMessage = content;
    if ((message_type === 'audio' || message_type === 'ptt') && transcription) {
        userMessage = `[Áudio Transcrito]: ${transcription}`;
    } else if (message_type === 'image') {
        userMessage = `[Imagem Enviada pelo Usuário]`;
    }
    
    if (!userMessage) return;

    const [agentsRes, companyRes, historyRes] = await Promise.all([
        supabase.from('agents').select('*').eq('company_id', company_id).eq('is_active', true),
        supabase.from('companies').select('ai_config').eq('id', company_id).single(),
        supabase.from('messages').select('content, from_me, message_type, transcription, created_at').eq('company_id', company_id).eq('remote_jid', remote_jid).eq('from_me', false).neq('id', id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    ]);

    const activeAgents = agentsRes.data || [];
    const lastMsgDate = historyRes.data?.created_at || null;
    const companyConfig = companyRes.data?.ai_config;

    const { agent, reason } = matchAgent(userMessage, lead, lastMsgDate, activeAgents);
    if (!agent) {
        console.log("   ❌ Bloqueio: Nenhum agente deu Match.");
        return;
    }

    console.log(`   🚀 Agente Acionado: ${agent.name} (${reason})`);
    Logger.info('sentinel', `Agente: ${agent.name}`, { lead: phone, trigger: reason }, company_id);

    try {
        let activeApiKey = companyConfig?.apiKey || process.env.API_KEY || process.env.GEMINI_API_KEY; 
        if (!activeApiKey) {
            console.warn(`   ❌ Bloqueio: Sem API Key!`);
            return;
        }

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
        
        const agora = new Date();
        const dataCompleta = agora.toLocaleDateString('pt-BR', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
        });
        const horaCompleta = agora.toLocaleTimeString('pt-BR');
        
        systemInstruction += `\n[CONTEXTO ATUAL]\nCliente: ${lead.name}\nHoje é: ${dataCompleta} às ${horaCompleta}\n${filesKnowledge}`;

        let toolsConfig = [];
        if (agent.level === 'senior' || agent.level === 'pleno') {
            toolsConfig = [{ functionDeclarations: ALL_TOOLS }];
        } else {
            toolsConfig = [{ functionDeclarations: ALL_TOOLS.filter(t => t.name === 'transfer_to_human') }];
        }

        const model = genAI.getGenerativeModel({ 
            model: activeModel,
            systemInstruction,
            tools: toolsConfig 
        });

        const chat = model.startChat({
            history: chatHistory,
            generationConfig: {
                temperature: 0.5,
                maxOutputTokens: 1000
            }
        });

        console.log(`   🧠 [GEMINI] Pensando e chamando Google API...`);

        let result = await chat.sendMessage(userMessage);
        let response = result.response;
        let functionCalls = response.functionCalls();
        let loopLimit = 0;

        while (functionCalls && functionCalls.length > 0 && loopLimit < 3) {
            loopLimit++;
            const toolResults = [];

            for (const call of functionCalls) {
                console.log(`   🛠️ Executando Tool: ${call.name}`);
                let output = {};

                try {
                    if (call.name === 'check_availability') {
                        output = await checkAvailability(company_id, call.args.dateISO);
                    }
                    else if (call.name === 'schedule_meeting') {
                        output = await scheduleMeeting(company_id, lead.id, call.args.title, call.args.dateISO, call.args.description, lead.owner_id);
                    }
                    else if (call.name === 'transfer_to_human') {
                        const reportingPhones = agent.tools_config?.reporting_phones || [];
                        await handoffAndReport(company_id, lead.id, remote_jid, call.args.summary, call.args.reason, reportingPhones);
                        console.log("   🛑 Chat transferido para humano.");
                        return; 
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
                            output = { success: true, message: "Arquivo enviado com sucesso." };
                        } else {
                            output = { success: false, message: "Sessão do WhatsApp desconectada." };
                        }
                    }
                } catch (toolError) {
                    console.error("   ❌ Erro na Tool:", toolError.message);
                    output = { error: toolError.message };
                }

                toolResults.push({
                    functionResponse: {
                        name: call.name,
                        response: output
                    }
                });
            }

            result = await chat.sendMessage(toolResults);
            response = result.response;
            functionCalls = response.functionCalls();
        }

        const finalReply = response.text();

        if (finalReply) {
            console.log(`   💬 Resposta final gerada, enviando para Baileys...`);
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
                console.log(`   ✅ SUCESSO: Mensagem colocada na fila de envio!`);
            } else {
                console.log("   ❌ ERRO: Sessão (SessionId) não encontrada.");
            }
        }

    } catch (error) {
        if (error.message?.includes('404')) {
             console.error("   ❌ ERRO FATAL: Modelo 2.5 Flash Inexistente para esta API Key.");
        } else if (!error.message?.includes('SAFETY')) {
            console.error("   ❌ ERRO NA API GEMINI:", error.message);
        }
    }
};

// 🛡️ FIX 2: Loop Infinito de Reconexão para driblar quedas no Render
let sentinelChannel = null;

export const startSentinel = () => {
    console.log("🛡️ [SENTINEL] Preparando conexão Realtime com o banco...");
    
    if (sentinelChannel) {
        supabase.removeChannel(sentinelChannel);
    }

    // Nome dinâmico para garantir que o canal seja sempre "fresco"
    sentinelChannel = supabase.channel(`ai-sentinel-${Date.now()}`);

    sentinelChannel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, processAIResponse)
        .subscribe((status, err) => {
            console.log(`📡 [REALTIME STATUS]: ${status}`);
            
            if (status === 'SUBSCRIBED') {
                console.log("🟢 [SENTINEL] Conectado e escutando ativamente!");
            } 
            else if (status === 'TIMED_OUT' || status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                console.log("⚠️ [SENTINEL] Realtime falhou/caiu. Tentando reconectar em 5 segundos...");
                sentinelChannel = null;
                setTimeout(() => {
                    startSentinel();
                }, 5000);
            }
            if (err) {
                console.error("❌ ERRO INTERNO DE REALTIME:", err);
            }
        });
};
