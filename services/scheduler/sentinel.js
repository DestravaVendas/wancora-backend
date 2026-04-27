import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI, Type } from "@google/genai";
import { sendMessage, markMessageAsRead, markMessageAsPlayed, sendReaction } from "../baileys/sender.js";
import { getSessionId } from "../../controllers/whatsappController.js";
import { scheduleMeeting, handoffAndReport, checkAvailability, searchFiles, sendFile } from "../ai/agentTools.js";
import { Logger } from "../../utils/logger.js";
import { buildSystemPrompt } from "../../utils/promptBuilder.js";
import { ensureLeadExists } from "../crm/sync.js";
import { EventEmitter } from "events";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// 🛡️ O antigo aiBus foi desativado em favor da Queue BullMQ (Redis)
// Mantido caso outras partes locais necessitem, mas core agora usa aiQueue.js
export const aiBus = new EventEmitter();

const processingLock = new Set();
const aiInstances = new Map();

// Helper de Atraso Humano
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// ⏰ [TIME GUARDIAN PROTOCOL] — Horário Comercial Dinâmico
// Bloqueia respostas da IA avaliando as configurações salvas do Supabase no flow_config.
const isWithinBusinessHours = (agent) => {
    const config = agent?.flow_config?.business_hours;
    if (!config || config.enabled !== true) return true; // Libera se não configurado ou desligado

    const now = new Date();
    const tz = config.timezone || 'America/Sao_Paulo';
    
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        });
        
        const timeParts = formatter.format(now).split(':');
        const currentHours = parseInt(timeParts[0], 10);
        const h24 = currentHours === 24 ? 0 : currentHours;
        const currentMinutes = (h24 * 60) + (parseInt(timeParts[1], 10) || 0);
        
        const parseTime = (timeStr) => {
            const [h, m] = (timeStr || "00:00").split(':').map(n => parseInt(n, 10));
            return (h * 60) + (m || 0);
        };

        const startMinutes = parseTime(config.start || "08:00");
        const endMinutes = parseTime(config.end || "20:00");

        if (startMinutes <= endMinutes) {
             return currentMinutes >= startMinutes && currentMinutes < endMinutes;
        } else {
             // Caso a janela cruze a meia noite (ex: 22h as 04h)
             return currentMinutes >= startMinutes || currentMinutes < endMinutes;
        }
    } catch(e) {
        console.error("Erro no isWithinBusinessHours:", e);
        return true; 
    }
};

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
        description: "Agenda uma reunião no calendário após confirmar o horário com o cliente. OBRIGATÓRIO: Use apenas a propriedade 'dateISO'.",
        parameters: {
            type: Type.OBJECT,
            properties: {
                title: { type: Type.STRING, description: "Título do evento." },
                dateISO: { type: Type.STRING, description: "Data e hora exata acordada em formato ISO 8601 (ex: 2026-04-16T14:30:00). Nunca use propriedades 'date' e 'time' separadas." },
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

// 🛡️ NOVO GATILHO DIRETO (Sem Memory-Limit)
// Acionada exclusivamente pelo aiWorker (BullMQ) para processamento resiliente.
export const internalProcessAI = async (messageData) => {
    const { whatsapp_id: id, content, remote_jid, company_id, from_me, message_type, transcription, created_at, session_id: msgSessionId } = messageData;

    console.log(`\n🔔 [RAIO-X SENTINEL] Processando:`, id);

    // O [TIME GUARDIAN] foi movido mais para baixo após sabermos qual agente deu match.

    // 🛡️ [ESTABILIDADE] Bloqueio de mensagens vazias ou não descriptografadas
    if (!content && !transcription) {
        console.log(`   ⚠️ [SENTINEL] Mensagem ${id} sem conteúdo ou transcrição. Ignorando.`);
        return;
    }

    const msgTime = new Date(created_at).getTime();
    const msgAgeSeconds = (Date.now() - msgTime) / 1000;
    // 🛡️ [FIX BUG 1] O guard de 180s bloqueava TODOS os jobs do Recovery Watchdog.
    // Jobs marcados com is_recovery=true já aguardaram 3-15min — bypass obrigatório.
    // Limite ampliado para 1h para conversas reais que podem demorar (ex: histórico recente).
    const maxAgeSeconds = messageData.is_recovery ? (60 * 60) : 180; // 1h para recovery, 3min para realtime
    if (msgAgeSeconds > maxAgeSeconds) {
        if (!messageData.is_recovery) {
            console.log(`   ❌ Bloqueio: Mensagem muito antiga (${Math.round(msgAgeSeconds)}s > ${maxAgeSeconds}s).`);
            return;
        }
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
        console.log(`   🆕 [SENTINEL] Lead não encontrado para ${phone}. Sincronizando de forma segura...`);
        // Chama a função central do Wancora que possui a trava Anti-Race Condition
        const leadId = await ensureLeadExists(`${phone}@s.whatsapp.net`, company_id, content || 'Novo Contato', remote_jid);
        
        if (leadId) {
            const { data: syncedLead } = await supabase.from('leads')
                .select('id, name, bot_status, owner_id, pipeline_stage_id')
                .eq('id', leadId).eq('company_id', company_id).single();
            lead = syncedLead;
        }

        if (!lead) {
            console.log(`   ❌ Bloqueio: Lead criado e lockado por outra thread (Sync). Aguardando liberação...`);
            // Dispara um erro intencional para a fila reprocessar depois via BullMQ
            throw new Error('Sync Lock Ativo: Reprocessar na próxima tentativa.');
        }
    }

    if (lead.bot_status === 'off') {
        console.log(`   ❌ Bloqueio: Status do bot é 'off'.`);
        return;
    }

    console.log(`   ✅ Lead Validado: ${lead.name}`);

    let userMessage = content;
    if ((message_type === 'audio' || message_type === 'ptt') && transcription) {
        userMessage = `[Áudio Transcrito]: ${transcription}`;
    } else if ((message_type === 'audio' || message_type === 'ptt') && !transcription) {
        // 🛡️ [ANTI-VÁCUO DE ÁUDIO] Transcrição ainda não chegou (race condition com pipeline async)
        // ou o Vertex/Gemini estava com rate limit. A IA recebe um placeholder e responde
        // com empatia em vez de deixar o lead sem resposta.
        userMessage = `[O cliente enviou um áudio. A transcrição não está disponível no momento. Responda empaticamente pedindo que reenvie ou explique por texto.]`;
        console.log(`   🎙️ [SENTINEL] Áudio sem transcrição (msg ${id}). Usando placeholder empático.`);
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

    // ⏰ [TIME GUARDIAN] Verificação dinâmica de horário comercial
    if (!isWithinBusinessHours(agent)) {
        const now = new Date().toLocaleTimeString('pt-BR', { timeZone: agent?.flow_config?.business_hours?.timezone || 'America/Sao_Paulo' });
        console.log(`   🌙 [TIME GUARDIAN] Bloqueio: Fora do horário configurado do Agente ${agent.name}. Hora atual: ${now}.`);
        return;
    }

    console.log(`   🚀 Agente Acionado: ${agent.name} (${reason})`);
    Logger.info('sentinel', `Agente: ${agent.name}`, { lead: phone, trigger: reason }, company_id);

    try {
        // 🛡️ [KEY RESOLVER] Prioridade: DB (se preenchida) > API_KEY env > GEMINI_API_KEY env
        // String vazia no banco é ignorada (tratada como não configurada)
        const dbApiKey = (companyConfig?.apiKey || '').trim();
        const envKey1  = (process.env.API_KEY || '').trim();
        const envKey2  = (process.env.GEMINI_API_KEY || '').trim();

        let activeApiKey = dbApiKey || envKey1 || envKey2;
        
        // 🔍 [DIAGNÓSTICO] Log de qual chave está sendo usada (não expõe a chave completa)
        const keySource = dbApiKey ? 'DB (ai_config)' : envKey1 ? 'ENV: API_KEY' : envKey2 ? 'ENV: GEMINI_API_KEY' : 'NENHUMA';
        const keyPreview = activeApiKey ? `${activeApiKey.slice(0, 6)}...${activeApiKey.slice(-4)}` : 'N/A';
        console.log(`   🔑 [KEY] Fonte: ${keySource} | Preview: ${keyPreview}`);

        if (!activeApiKey) {
            console.warn(`   ❌ Bloqueio: Nenhuma API Key configurada para empresa ${company_id}`);
            return;
        }


        // 🛡️ MODEL SELECTOR: Usa modelo configurado pela empresa, com fallback para o
        // modelo estável de produção. Modelos -preview são PROIBIDOS em produção.
        const STABLE_DEFAULT_MODEL = 'gemini-2.0-flash';
        const PREVIEW_PATTERN = /preview/i;
        let activeModel = STABLE_DEFAULT_MODEL;
        if (companyConfig?.model && !PREVIEW_PATTERN.test(companyConfig.model)) {
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

        // 🛡️ [ISOLAMENTO CRÍTICO] Instrução de Bolha: Garante que a IA saiba exatamente com quem fala
        systemInstruction += `\n\n[DIRETRIZ DE ISOLAMENTO]\nVocê está em uma conversa PRIVADA e ISOLADA com o cliente "${lead.name}".\nNUNCA mencione outros clientes ou misture contextos.\nTrate esta conversa como uma bolha única.`;
        systemInstruction += `\n[CONTEXTO ATUAL]\nCliente: ${lead.name}\nHoje é: ${dataCompleta} às ${horaCompleta}\n${filesKnowledge}`;

        // Libera as tools com base no nível do agente
        let toolsConfig = [];
        if (agent.level === 'senior') {
            toolsConfig = [{ functionDeclarations: ALL_TOOLS }];
        } else if (agent.level === 'pleno') {
            toolsConfig = [{ functionDeclarations: ALL_TOOLS.filter(t => ['transfer_to_human', 'check_availability', 'schedule_meeting'].includes(t.name)) }];
        } else {
            // Junior
            toolsConfig = [{ functionDeclarations: ALL_TOOLS.filter(t => t.name === 'transfer_to_human') }];
        }

        // 🧠 IMPLEMENTAÇÃO SDK ESTÁVEL COM RETRY DUPLO (503 e 429)
        let contents = [...chatHistory, { role: 'user', parts: [{ text: userMessage }] }];

        console.log(`   🧠 [GEMINI] Pensando (Model: ${activeModel})...`);

        // ⚡ BACKOFF EXPONENCIAL SEVERO: 503 = Sobrecarga do servidor, 429 = Rate Limit da API Key
        // - 503: Usa base de 3s (3s → 6s → 12s → 24s → 48s), troca de modelo na 3ª tentativa
        // - 429: Usa base de 15s (15s → 30s → 90s), máx 3 tentativas. É severo porque cada retry 
        //        consome cota. Se esgotar, retorna NULL — nunca joga erro para cima e nunca mata a fila.
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
                const is429 = err.message?.includes('429') || err.status === 429 || err.message?.includes('Resource Exhausted') || err.message?.includes('RESOURCE_EXHAUSTED');

                // --- TRATAMENTO 503: Sobrecarga do servidor Gemini ---
                if (is503 && retryCount < 5) {
                    const waitTime = Math.pow(2, retryCount) * 3000;
                    console.warn(`   ⚠️ [GEMINI 503] Alta Demanda. Tentativa ${retryCount + 1}/5 em ${waitTime}ms...`);
                    await delay(waitTime);

                    // Na 3ª tentativa, downgrade para modelo mais leve
                    if (retryCount === 2) {
                        console.warn(`   🔄 [GEMINI] Downgrade para gemini-1.5-flash por sobrecarga persistente.`);
                        activeModel = 'gemini-1.5-flash';
                    }
                    return generateWithRetry(currentContents, retryCount + 1);
                }

                // --- 🛡️ TRATAMENTO 429: Rate Limit (CRÍTICO - ANTI-QUEDA) ---
                // Backoff severo: 15s → 30s → 90s (3 tentativas máximas)
                // NUNCA relança o erro. Se esgotar, retorna null para não matar a fila.
                if (is429 && retryCount < 3) {
                    const waitTime = retryCount === 0 ? 15000 : retryCount === 1 ? 30000 : 90000;
                    console.warn(`   🚫 [GEMINI 429] Rate Limit atingido. Aguardando ${waitTime / 1000}s (Tentativa ${retryCount + 1}/3)...`);
                    Logger.warn?.('sentinel', `Rate Limit 429 atingido`, { tentativa: retryCount + 1, aguardo_ms: waitTime }, company_id);
                    await delay(waitTime);
                    return generateWithRetry(currentContents, retryCount + 1);
                }

                if (is429) {
                    // Esgotou todas as tentativas de 429: tenta fallback para gemini-1.5-flash (quota separada).
                    // Se também falhar, aborta silenciosamente para não derrubar a fila.
                    if (activeModel !== 'gemini-1.5-flash') {
                        console.warn(`   🔄 [GEMINI 429] Tentando fallback para gemini-1.5-flash (quota separada)...`);
                        activeModel = 'gemini-1.5-flash';
                        await delay(5000); // Pausa curta antes de tentar o modelo alternativo
                        return generateWithRetry(currentContents, 0); // Reinicia contagem de retries com novo modelo
                    }
                    // Se já está em gemini-1.5-flash e ainda está em 429, desiste:
                    console.error(`   ❌ [GEMINI 429] Rate Limit persistente em ambos os modelos. Abortando sem derrubar a fila.`);
                    Logger.error?.('sentinel', `Rate Limit 429 Fatal (ambos modelos)`, { aviso: 'Resposta abortada silenciosamente.' }, company_id);
                    return null;
                }

                throw err;
            }
        };

        let result = await generateWithRetry(contents);

        // 🛡️ Guarda de segurança: Se generateWithRetry retornou null (ex: 429 esgotado), aborta silenciosamente.
        if (!result) {
            console.warn(`   ⚠️ [SENTINEL] Resultado nulo (Rate Limit esgotado). Marcando ai_error para rastreabilidade.`);
            // 🛡️ [RASTREABILIDADE] Persiste o erro no banco para o Recovery Watchdog (Missão D) detectar
            // e re-enfileirar a mensagem após o rate limit se recuperar.
            supabase.from('messages')
                .update({ ai_processed: false, ai_error: 'RATE_LIMIT_429' })
                .eq('whatsapp_id', id)
                .eq('company_id', company_id)
                .then()
                .catch(() => {});
            return;
        }


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
                        const safeDateArgs = call.args.dateISO || call.args.date || call.args.date_iso;
                        output = await checkAvailability(company_id, safeDateArgs);
                    }
                    else if (call.name === 'schedule_meeting') {
                        let finalIso = call.args.dateISO;

                        // Polyfill dinâmico caso a IA cometa o erro de desmembrar date e time
                        if (!finalIso && call.args.date) {
                            const t = call.args.time || "00:00:00";
                            if (call.args.date.includes('T')) {
                                finalIso = call.args.date;
                            } else {
                                finalIso = `${call.args.date}T${t}`;
                                if (!finalIso.includes('-03:00') && !finalIso.includes('Z')) finalIso += '-03:00';
                            }
                        }

                        output = await scheduleMeeting(company_id, lead.id, call.args.title, finalIso, call.args.description, lead.owner_id);
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

        let finalReply = response.text;

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

                // 🛡️ [HUMANIZAÇÃO] Extração de Reação (React)
                let extractedEmoji = null;
                const reactRegex = /\[REACT:\s*(.+?)\]/i;
                const reactMatch = finalReply.match(reactRegex);
                if (reactMatch) {
                    extractedEmoji = reactMatch[1].trim();
                    finalReply = finalReply.replace(reactRegex, '').trim();
                    console.log(`   ❤️ Reação detectada: ${extractedEmoji}`);
                    await sendReaction(sessionId, remote_jid, id, extractedEmoji);
                }

                // 🛡️ [HUMANIZAÇÃO] Atraso extra para escutar áudio + Microfone Azul
                let listeningDelay = 0;
                if (message_type === 'audio' || message_type === 'ptt') {
                    if (transcription) {
                        // Calcula o tempo que um humano levaria para ouvir o áudio (aproximado pela transcrição)
                        listeningDelay = Math.min(Math.max(transcription.length * 60, 2000), 25000);
                        console.log(`   🎧 Áudio recebido. Simulando escuta por ${Math.round(listeningDelay / 1000)}s...`);
                        await delay(listeningDelay);
                    }
                    // Marca o audio como escutado (Microfone Azul)
                    await markMessageAsPlayed(sessionId, remote_jid, id);
                }

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
                        console.log(`   ✅ Parte ${i + 1}/${chunks.length} enviada! (Digitou por ${Math.round(typingTime / 1000)}s)`);

                        // PASSO 6: O "respiro" natural entre enviar uma parte e começar a digitar a próxima
                        if (i < chunks.length - 1) {
                            await delay(randomDelay(1500, 3500));
                        }
                    } catch (sendError) {
                        console.error("   ❌ [ERRO AO ENVIAR PARTE]:", sendError.message);
                    }
                }

                // ✅ [RASTREABILIDADE] Marca como processado com sucesso para o Recovery Watchdog
                // Fire-and-forget: não bloqueia o Event Loop.
                supabase.from('messages')
                    .update({ ai_processed: true, ai_error: null })
                    .eq('whatsapp_id', id)
                    .eq('company_id', company_id)
                    .then()
                    .catch(() => {});

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

// 🛡️ O FIM DOS TIMEOUTS E MEMORY LOCKS
export const startSentinel = () => {
    // startSentinel mantido por compatibilidade de boot do server.js
    // Mas agora não escuta o EventBus (isso foi offloadado pra aiQueue.js via BullMQ/import em runtime)
    console.log("🟢 [SENTINEL] Inteligência Artificial pronta e disponível (Modo Async Queue)!");
};
