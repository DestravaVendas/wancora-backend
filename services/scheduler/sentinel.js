import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI, Type } from "@google/genai";
import { sendMessage, markMessageAsRead } from "../baileys/sender.js"; 
import { getSessionId } from "../../controllers/whatsappController.js";
import { scheduleMeeting, handoffAndReport, checkAvailability, searchFiles, sendFile } from "../ai/agentTools.js";
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
            type: Type.OBJECT,
            properties: {
                summary: { type: Type.STRING, description: "Resumo da conversa até agora." },
                reason: { type: Type.STRING, description: "Motivo da transferência." }
            },
            required: ["summary", "reason"]
        }
    },
    {
        name: "search_files",
        description: "Busca arquivos ou documentos no Google Drive da empresa para responder dúvidas.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                query: { type: Type.STRING, description: "Termo de busca do arquivo." }
            },
            required: ["query"]
        }
    },
    {
        name: "send_file",
        description: "Envia um arquivo encontrado no Drive para o cliente.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                google_id: { type: Type.STRING, description: "ID do arquivo no Google Drive (obtido via search_files)." }
            },
            required: ["google_id"]
        }
    },
    {
        name: "check_availability",
        description: "ANTES de sugerir um horário para o cliente, use esta ferramenta para consultar a agenda e ver quais horários estão OCUPADOS em uma data específica.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                dateISO: { type: Type.STRING, description: "A data desejada em formato ISO 8601 (ex: 2026-02-25T00:00:00Z)." }
            },
            required: ["dateISO"]
        }
    },
    {
        name: "schedule_meeting",
        description: "Agenda uma reunião no calendário após confirmar o horário com o cliente.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                title: { type: Type.STRING, description: "Título do evento." },
                dateISO: { type: Type.STRING, description: "Data e hora exata acordada em formato ISO 8601 (YYYY-MM-DDTHH:mm:ss)." },
                description: { type: Type.STRING, description: "Detalhes e pauta do agendamento." }
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
            const instance = new GoogleGenAI({ apiKey });
            aiInstances.set(apiKey, instance);
        } catch (e) {
            console.error("❌ [SENTINEL] Erro ao instanciar GoogleGenAI:", e.message);
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
const messageBuffers = new Map(); // 📥 Buffer para acumular mensagens (Debounce)

// 🛡️ ADAPTADO PARA RECEBER O PAYLOAD DIRETO DO EVENT BUS
const processAIResponse = async (messageData) => {
    if (!messageData) return;
    
    const { whatsapp_id: id, remote_jid, company_id, from_me, content } = messageData;

    if (from_me) return;
    if (remote_jid.includes('@g.us') || remote_jid.includes('@newsletter') || remote_jid === '0@s.whatsapp.net' || remote_jid === '12345678@broadcast') return;

    // --- LÓGICA DE ACUMULAÇÃO (DEBOUNCE) ---
    // Se o usuário mandar 3 mensagens seguidas, esperamos ele parar de digitar por 6s
    // para processar tudo de uma vez só, evitando respostas múltiplas e robóticas.
    
    if (!messageBuffers.has(remote_jid)) {
        messageBuffers.set(remote_jid, {
            messages: [messageData],
            timer: null
        });
    } else {
        const buffer = messageBuffers.get(remote_jid);
        buffer.messages.push(messageData);
        if (buffer.timer) clearTimeout(buffer.timer);
    }

    const buffer = messageBuffers.get(remote_jid);
    
    buffer.timer = setTimeout(() => {
        const finalMessages = [...buffer.messages];
        messageBuffers.delete(remote_jid);
        
        // Consolidamos o conteúdo de todas as mensagens acumuladas
        const combinedContent = finalMessages
            .map(m => m.content || m.transcription || "")
            .filter(t => t.length > 0)
            .join("\n");

        if (!combinedContent) return;

        // Usamos os metadados da ÚLTIMA mensagem, mas com o conteúdo combinado
        const lastMsg = finalMessages[finalMessages.length - 1];
        const consolidatedData = { ...lastMsg, content: combinedContent };

        // [FILA POR CONVERSA]
        if (!conversationLocks.has(remote_jid)) {
            conversationLocks.set(remote_jid, Promise.resolve());
        }

        const currentLock = conversationLocks.get(remote_jid);
        
        const nextTask = currentLock.then(async () => {
            try {
                await _internalProcessAI(consolidatedData);
            } catch (e) {
                console.error(`❌ [SENTINEL] Erro na fila de ${remote_jid}:`, e.message);
            }
        });

        conversationLocks.set(remote_jid, nextTask);

        nextTask.finally(() => {
            if (conversationLocks.get(remote_jid) === nextTask) {
                conversationLocks.delete(remote_jid);
            }
        });
    }, 6000); // Aguarda 6 segundos de silêncio do usuário
};

const _internalProcessAI = async (messageData) => {
    const { whatsapp_id: id, content, remote_jid, company_id, from_me, message_type, transcription, created_at, session_id: msgSessionId } = messageData;
    
    console.log(`\n🔔 [RAIO-X SENTINEL] Processando:`, id);

    // 🛡️ [ESTABILIDADE] Bloqueio de mensagens vazias ou não descriptografadas
    if (!content && !transcription) {
        console.log(`   ⚠️ [SENTINEL] Mensagem ${id} sem conteúdo ou transcrição. Ignorando.`);
        return;
    }

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

    const phone = remote_jid.split('@')[0].replace(/\D/g, '');
    console.log(`   🔍 Buscando Lead: ${phone}...`);

    // 🛡️ [SEGURANÇA] Busca exata para evitar match parcial de números (Ex: 123 matching 55123)
    // Tentamos primeiro com o número completo (com DDI) e depois sem DDI se necessário
    let { data: lead } = await supabase.from('leads')
        .select('id, name, bot_status, owner_id, pipeline_stage_id')
        .eq('company_id', company_id)
        .eq('phone', phone)
        .maybeSingle();

    if (!lead && phone.startsWith('55')) {
        const phoneWithoutDDI = phone.substring(2);
        const { data: fallbackLead } = await supabase.from('leads')
            .select('id, name, bot_status, owner_id, pipeline_stage_id')
            .eq('company_id', company_id)
            .eq('phone', phoneWithoutDDI)
            .maybeSingle();
        lead = fallbackLead;
    }

    if (!lead) {
        console.log(`   🆕 [SENTINEL] Lead não encontrado para ${phone}. Criando automaticamente...`);
        
        // Busca o estágio inicial do funil
        const { data: stage } = await supabase.from('pipeline_stages')
            .select('id')
            .eq('company_id', company_id)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();

        const { data: newLead, error: createError } = await supabase.from('leads').insert({
            company_id: company_id,
            phone: phone,
            name: `Novo Lead (${phone})`,
            status: 'new',
            bot_status: 'active',
            pipeline_stage_id: stage?.id,
            position: Date.now()
        }).select('id, name, bot_status, owner_id, pipeline_stage_id').single();

        if (createError) {
            console.error(`   ❌ [SENTINEL] Erro ao criar lead automático:`, createError.message);
            return;
        }
        lead = newLead;
    }

    if (lead.bot_status === 'off') {
        console.log(`   ❌ Bloqueio: Status do bot é 'off'.`);
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

        // MODEL FALLBACK: Força 3 Flash para escalar com velocidade e baixo custo
        let activeModel = 'gemini-3-flash-preview';
        if (companyConfig?.model && companyConfig.model !== 'gemini-1.5-flash' && companyConfig.model !== 'gemini-2.0-flash') {
             activeModel = companyConfig.model;
        }

        const ai = getAIClient(activeApiKey);
        if (!ai) return;

        // 🛡️ MEMÓRIA DE CURTO PRAZO: Busca as últimas 10 mensagens para contexto
        const contextLimit = 10;
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

        // 🧠 NOVA IMPLEMENTAÇÃO SDK ESTÁVEL COM RETRY (503)
        let contents = [...chatHistory, { role: 'user', parts: [{ text: userMessage }] }];
        
        console.log(`   🧠 [GEMINI] Pensando (Model: ${activeModel})...`);

        const generateWithRetry = async (currentContents, retryCount = 0) => {
            try {
                return await ai.models.generateContent({
                    model: activeModel,
                    contents: currentContents,
                    config: {
                        systemInstruction,
                        tools: toolsConfig,
                        temperature: 0.5
                    }
                });
            } catch (err) {
                const is503 = err.message?.includes('503') || err.status === 503;
                
                if (is503 && retryCount < 5) {
                    const waitTime = Math.pow(2, retryCount) * 3000; // Aumentado para 3s base
                    console.warn(`   ⚠️ [GEMINI] Erro 503 (Alta Demanda). Tentativa ${retryCount + 1}/5 em ${waitTime}ms...`);
                    await delay(waitTime);
                    
                    // Se estiver na 3ª tentativa e falhando, tenta trocar o modelo para o Flash Lite (mais leve)
                    if (retryCount === 2 && activeModel === 'gemini-3-flash-preview') {
                        console.warn(`   🔄 [GEMINI] Trocando para modelo de fallback (Flash Lite) devido à alta demanda.`);
                        activeModel = 'gemini-3.1-flash-lite-preview';
                    }

                    return generateWithRetry(currentContents, retryCount + 1);
                }
                throw err;
            }
        };

        let result = await generateWithRetry(contents);

        let response = result;
        let functionCalls = response.functionCalls;
        let loopLimit = 0;

        // Loop de tratamento de Tools
        while (functionCalls && functionCalls.length > 0 && loopLimit < 3) {
            loopLimit++;
            const toolResults = [];

            // Adiciona a resposta do modelo (que contém as chamadas de função) ao histórico
            contents.push(response.candidates[0].content);

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
                        output = await searchFiles(company_id, call.args.query);
                    } 
                    else if (call.name === 'send_file') {
                        output = await sendFile(company_id, remote_jid, call.args.google_id);
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

            // Adiciona os resultados das funções ao histórico
            contents.push({ role: 'user', parts: toolResults });

            result = await generateWithRetry(contents);
            response = result;
            functionCalls = response.functionCalls;
        }

        const finalReply = response.text;

        // =========================================================================
        // 🧠 FLUXO DE COMPORTAMENTO HUMANO AVANÇADO (VISUALIZAR, PENSAR, DIGITAR E QUEBRAR)
        // =========================================================================
        if (finalReply) {
            console.log(`   💬 Resposta final gerada. Iniciando comportamento humano...`);
            
            // 🕒 CONFIGURAÇÃO DE TIMING (ANTI-BAN)
            const timing = agent.flow_config?.timing || { min_delay_seconds: 10, max_delay_seconds: 30 };
            const minDelay = (timing.min_delay_seconds || 10) * 1000;
            const maxDelay = (timing.max_delay_seconds || 30) * 1000;

            // 🔥 CORREÇÃO: Usa o sessionId da mensagem original se disponível, senão busca o padrão
            const sessionId = msgSessionId || await getSessionId(company_id);
            
            if (sessionId) {
                // PASSO 1: Marcar como lida ("Visualizou")
                await markMessageAsRead(sessionId, remote_jid, id); 
                console.log(`   👀 Visto Azul enviado. Aguardando delay humano configurado...`);

                // PASSO 2: Ficar "olhando/pensando" por um tempo natural antes de começar a digitar
                // O delay inicial respeita o min/max do agente
                const initialDelay = randomDelay(minDelay * 0.4, minDelay * 0.8);
                await delay(initialDelay);

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
                    // A primeira mensagem finge que está formulando a ideia
                    // As partes seguintes digitam mais rápido com base no peso
                    let typingTime = randomDelay(5000, 8000); 
                    if (i > 0) {
                        typingTime = Math.min(Math.max(chunk.length * 35, 2500), 7000); 
                    }

                    try {
                        await sendMessage({
                            sessionId,
                            to: remote_jid,
                            type: 'text',
                            content: chunk,
                            timingConfig: { 
                                override_typing_time: typingTime, 
                                min_delay_seconds: timing.min_delay_seconds / 4, 
                                max_delay_seconds: timing.max_delay_seconds / 4
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
    
    // Ouve a mensagem localmente.
    aiBus.on('new_message_arrived', (messageData) => {
        // Removemos o timeout fixo de 2.5s pois agora usamos a lógica de Debounce/Acumulação de 6s dentro de processAIResponse
        processAIResponse(messageData).catch(e => console.error("Erro interno no Sentinel:", e));
    });

    console.log("🟢 [SENTINEL] IA Conectada na Memória RAM (Imune a quedas do Render e TIMED_OUT)!");
};
