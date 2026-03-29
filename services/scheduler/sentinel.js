import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { sendMessage, markMessageAsRead } from "../baileys/sender.js"; // 🔥 Módulo de Leitura Importado
import { getSessionId } from "../../controllers/whatsappController.js";
import { scheduleMeeting, handoffAndReport, checkAvailability } from "../ai/agentTools.js";
import { Logger } from "../../utils/logger.js";
import { buildSystemPrompt } from "../../utils/promptBuilder.js"; 
import { EventEmitter } from "events"; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// 🛡️ EVENT BUS LOCAL: Comunicação instantânea na memória RAM
export const aiBus = new EventEmitter();

const processingLock = new Set();
const aiInstances = new Map();

// Helper de Atraso Humano
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

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

// 🛡️ [ESTABILIDADE] Fila de Conversação por Lead
// Garante que a IA não responda múltiplas vezes ao mesmo tempo para o mesmo lead
// e que as mensagens sejam processadas em ordem.
const conversationLocks = new Map();

// 🛡️ ADAPTADO PARA RECEBER O PAYLOAD DIRETO DO EVENT BUS
const processAIResponse = async (messageData) => {
    if (!messageData) return;
    
    const { whatsapp_id: id, remote_jid, company_id, from_me } = messageData;

    if (from_me) return;
    if (remote_jid.includes('@g.us') || remote_jid.includes('@newsletter') || remote_jid === '0@s.whatsapp.net' || remote_jid === '12345678@broadcast') return;

    // [FILA POR CONVERSA]
    // Se já houver um processamento em curso para este lead, aguardamos ele terminar.
    if (!conversationLocks.has(remote_jid)) {
        conversationLocks.set(remote_jid, Promise.resolve());
    }

    const currentLock = conversationLocks.get(remote_jid);
    
    // Enfileiramos o processamento desta mensagem
    const nextTask = currentLock.then(async () => {
        try {
            await _internalProcessAI(messageData);
        } catch (e) {
            console.error(`❌ [SENTINEL] Erro na fila de ${remote_jid}:`, e.message);
        }
    });

    conversationLocks.set(remote_jid, nextTask);

    // Limpeza da fila após o término para não vazar memória
    nextTask.finally(() => {
        if (conversationLocks.get(remote_jid) === nextTask) {
            conversationLocks.delete(remote_jid);
        }
    });
};

const _internalProcessAI = async (messageData) => {
    const { whatsapp_id: id, content, remote_jid, company_id, from_me, message_type, transcription, created_at, session_id: msgSessionId } = messageData;
    
    console.log(`\n🔔 [RAIO-X SENTINEL] Processando:`, id);

    const msgTime = new Date(created_at).getTime();
    if ((Date.now() - msgTime) / 1000 > 180) {
        console.log(`   ❌ Bloqueio: Mensagem muito antiga.`);
        return; 
    } 

    const lockKey = `${remote_jid}-${id}`;
    if (processingLock.has(lockKey)) {
        console.log("   ❌ Bloqueio: Em processamento.");
        return;
    }
    processingLock.add(lockKey);
    // 🛡️ Aumentamos a tranca para 60s, pois agora a IA vai "demorar" muito tempo agindo como humano
    setTimeout(() => processingLock.delete(lockKey), 60000);

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
    
    if (!userMessage) {
        console.log("   ❌ Bloqueio: Mensagem vazia ou não descriptografada.");
        return;
    }

    const [agentsRes, companyRes, historyRes] = await Promise.all([
        supabase.from('agents').select('*').eq('company_id', company_id).eq('is_active', true),
        supabase.from('companies').select('ai_config').eq('id', company_id).single(),
        supabase.from('messages').select('content, from_me, message_type, transcription, created_at').eq('company_id', company_id).eq('remote_jid', remote_jid).eq('from_me', false).neq('whatsapp_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle()
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
            console.warn(`   ❌ Bloqueio: Nenhuma API Key configurada para empresa ${company_id}`);
            return;
        }

        // MODEL FALLBACK: Força 2.0 Flash para escalar com velocidade e baixo custo
        let activeModel = 'gemini-2.0-flash';
        if (companyConfig?.model && companyConfig.model !== 'gemini-1.5-flash') {
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
            .neq('whatsapp_id', id) 
            .order('created_at', { ascending: false })
            .limit(contextLimit);

        let chatHistory = [];
        if (chatHistoryData && chatHistoryData.length > 0) {
            // Mapeia e inverte para ordem cronológica
            const rawHistory = chatHistoryData.reverse().map(m => {
                let txt = m.content || "";
                if ((m.message_type === 'audio' || m.message_type === 'ptt') && m.transcription) {
                    txt = `[Áudio]: ${m.transcription}`;
                }
                return {
                    role: m.from_me ? 'model' : 'user',
                    parts: [{ text: txt }]
                };
            });

            // Encontra o índice da primeira mensagem que é 'user'
            const firstUserIndex = rawHistory.findIndex(msg => msg.role === 'user');
            
            // Só adiciona ao histórico a partir desse ponto (remove os 'model' soltos no início)
            if (firstUserIndex !== -1) {
                chatHistory = rawHistory.slice(firstUserIndex);
            }
        }

        let systemInstruction = buildSystemPrompt(agent);
        const filesKnowledge = agent.knowledge_config?.text_files?.map(f => `Arquivo: ${f.name} - Link: ${f.url}`).join('\n') || '';
        
        // Consciência Temporal (Dia da semana + Data completa)
        const agora = new Date();
        const dataCompleta = agora.toLocaleDateString('pt-BR', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
        });
        const horaCompleta = agora.toLocaleTimeString('pt-BR');
        
        systemInstruction += `\n[CONTEXTO ATUAL]\nCliente: ${lead.name}\nHoje é: ${dataCompleta} às ${horaCompleta}\n${filesKnowledge}`;

        // Libera as tools com base no nível do agente
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

        console.log(`   🧠 [GEMINI] Pensando (Model: ${activeModel})...`);

        let result = await chat.sendMessage(userMessage);
        let response = result.response;
        let functionCalls = response.functionCalls();
        let loopLimit = 0;

        // Loop de tratamento de Tools
        while (functionCalls && functionCalls.length > 0 && loopLimit < 3) {
            loopLimit++;
            const toolResults = [];

            for (const call of functionCalls) {
                console.log(`   🛠️ Executando Tool: ${call.name} com args:`, call.args);
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
                        return; // Encerra a IA imediatamente, humano assumiu
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
                                companyId: company_id
                            }).catch(() => {});
                            output = { success: true, message: "Arquivo enviado com sucesso." };
                        } else {
                            output = { success: false, message: "Sessão desconectada." };
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

        // =========================================================================
        // 🧠 FLUXO DE COMPORTAMENTO HUMANO AVANÇADO (VISUALIZAR, PENSAR, DIGITAR E QUEBRAR)
        // =========================================================================
        if (finalReply) {
            console.log(`   💬 Resposta final gerada. Iniciando comportamento humano...`);
            
            // 🔥 CORREÇÃO: Usa o sessionId da mensagem original se disponível, senão busca o padrão
            const sessionId = msgSessionId || await getSessionId(company_id);
            
            if (sessionId) {
                // PASSO 1: Marcar como lida ("Visualizou")
                await markMessageAsRead(sessionId, remote_jid, id); // Usa o id (whatsapp_id) mapeado no topo
                console.log(`   👀 Visto Azul enviado. Agurdando ~10 segundos...`);

                // PASSO 2: Ficar "olhando/pensando" por um tempo natural antes de começar a digitar
                await delay(randomDelay(8000, 12000));

                // PASSO 3: Quebra Inteligente de Mensagem
                // A IA agora envia a flag [SPLIT] quando ela mesma quer dividir a mensagem em balões diferentes
                let rawChunks = finalReply.split(/\[SPLIT\]/i).map(c => c.trim()).filter(c => c.length > 0);
                
                // Fallback de segurança: Se a IA não obedeceu o SPLIT e gerou um bloco gigante de texto, forçamos a quebra por frase
                if (rawChunks.length === 1 && finalReply.length > 300) {
                    rawChunks = finalReply.split(/\n\n+/).map(c => c.trim()).filter(c => c.length > 0);
                }

                // Agrupa pequenos pedaços (ex: um "Ok!") com a frase seguinte para não enviar balões minúsculos
                let chunks = [];
                let tempStr = "";
                for (const c of rawChunks) {
                    if (tempStr.length + c.length < 150) { 
                        tempStr += (tempStr.length > 0 ? "\n" : "") + c;
                    } else {
                        if (tempStr) chunks.push(tempStr);
                        tempStr = c;
                    }
                }
                if (tempStr) chunks.push(tempStr);
                
                if (chunks.length === 0) chunks = [finalReply]; 

                // Limite de sanidade: Máximo de 4 balões seguidos para evitar ser invasivo
                if (chunks.length > 4) {
                    const limitChunks = [chunks[0]];
                    limitChunks.push(chunks.slice(1, -1).join('\n\n'));
                    limitChunks.push(chunks[chunks.length - 1]);
                    chunks = limitChunks.filter(c => c.length > 0);
                }

                // PASSO 4: Loop de Envio Fracionado
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    
                    // PASSO 5: Definir o tempo do "Digitando..."
                    // A primeira mensagem finge que está formulando a ideia (7 a 10s)
                    // As partes seguintes digitam mais rápido com base no peso (simulando que já sabe o que vai dizer)
                    let typingTime = randomDelay(7000, 10000); 
                    if (i > 0) {
                        typingTime = Math.min(Math.max(chunk.length * 40, 3000), 8000); 
                    }

                    try {
                        await sendMessage({
                            sessionId,
                            to: remote_jid,
                            type: 'text',
                            content: chunk,
                            timingConfig: { 
                                override_typing_time: typingTime, // Força o tempo exato do comando "digitando..."
                                min_delay_seconds: 1, 
                                max_delay_seconds: 2
                            },
                            companyId: company_id
                        });
                        console.log(`   ✅ Parte ${i+1}/${chunks.length} enviada! (Digitou por ${Math.round(typingTime/1000)}s)`);
                        
                        // PASSO 6: O "respiro" natural entre enviar uma parte e começar a digitar a próxima
                        if (i < chunks.length - 1) {
                            await delay(randomDelay(1500, 3500));
                        }
                    } catch (sendError) {
                        console.error("   ❌ [ERRO AO ENVIAR PARTE]:", sendError.message);
                    }
                }
            } else {
                console.log("   ❌ ERRO: Sessão não encontrada.");
            }
        }

    } catch (error) {
        console.error("\n   ❌ [ERRO CRÍTICO NA EXECUÇÃO DA IA]:", error);
        
        if (error.message?.includes('404')) {
             Logger.error('sentinel', `Erro Fatal IA: Modelo Inexistente`, { details: "API Key inválida." }, company_id);
        } else if (!error.message?.includes('SAFETY')) {
            Logger.error('sentinel', `Erro Fatal na IA`, { error: error.message }, company_id);
        }
    }
};

// 🛡️ O FIM DOS TIMEOUTS. MOTOR LIGADO NA RAM.
export const startSentinel = () => {
    console.log("🛡️ [SENTINEL] Preparando barramento de eventos locais (EventBus)...");
    
    aiBus.removeAllListeners('new_message_arrived');
    
    // Ouve a mensagem localmente. O delay de 2.5s foi mantido para a segurança do Mutex.
    aiBus.on('new_message_arrived', (messageData) => {
        setTimeout(() => {
            processAIResponse(messageData).catch(e => console.error("Erro interno no Sentinel:", e));
        }, 2500); 
    });

    console.log("🟢 [SENTINEL] IA Conectada na Memória RAM (Imune a quedas do Render e TIMED_OUT)!");
};
