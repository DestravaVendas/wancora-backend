
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { sendMessage } from "../baileys/sender.js";
import { getSessionId } from "../../controllers/whatsappController.js";
import { scheduleMeeting, handoffAndReport } from "../ai/agentTools.js";
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

const processAIResponse = async (payload) => {
    const { id, content, remote_jid, company_id, from_me, message_type, media_url, transcription, created_at } = payload.new;

    if (from_me) return;
    
    // Ignora grupos e newsletters
    if (remote_jid.includes('@g.us') || remote_jid.includes('@newsletter')) return;

    // Horizonte de Eventos (2 min)
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
        .select('id, name, bot_status, owner_id')
        .eq('company_id', company_id)
        .eq('phone', phone)
        .maybeSingle();

    if (!lead || lead.bot_status !== 'active') return;

    // --- 2. Carrega Agente Ativo ---
    const [agentRes, companyRes] = await Promise.all([
        supabase.from('agents').select('*').eq('company_id', company_id).eq('is_active', true).maybeSingle(),
        supabase.from('companies').select('ai_config').eq('id', company_id).single()
    ]);

    const agent = agentRes.data;
    const companyConfig = companyRes.data?.ai_config;
    if (!agent) return;

    // --- 3. Prepara Input (Texto ou Transcrição) ---
    let userMessage = content;
    if ((message_type === 'audio' || message_type === 'ptt') && transcription) {
        userMessage = `[Áudio Transcrito]: ${transcription}`;
    } else if (message_type === 'image') {
        userMessage = `[Imagem Enviada] ${content || ''}`;
    }
    
    if (!userMessage) return; // Se não tem texto nem transcrição, ignora

    try {
        let activeApiKey = companyConfig?.apiKey || process.env.API_KEY;
        // Junior e Pleno usam Flash, Senior usa Pro (para melhor raciocínio)
        let activeModel = 'gemini-3-flash-preview'; 
        if (agent.level === 'senior') activeModel = 'gemini-3-pro-preview';
        if (companyConfig?.model) activeModel = companyConfig.model; // Override da empresa

        const ai = getAIClient(activeApiKey);
        if (!ai) return;

        // --- 4. Definição de Nível e Contexto ---
        let contextLimit = 5; // Junior
        if (agent.level === 'pleno') contextLimit = 12;
        if (agent.level === 'senior') contextLimit = 30;

        const { data: history } = await supabase
            .from('messages')
            .select('content, from_me, message_type, transcription')
            .eq('company_id', company_id)
            .eq('remote_jid', remote_jid)
            .neq('id', id)
            .order('created_at', { ascending: false })
            .limit(contextLimit);

        const chatHistory = (history || []).reverse().map(m => {
            let txt = m.content || "";
            if ((m.message_type === 'audio' || m.message_type === 'ptt') && m.transcription) {
                txt = `[Áudio]: ${m.transcription}`;
            }
            return {
                role: m.from_me ? 'model' : 'user',
                parts: [{ text: txt }]
            };
        });

        // --- 5. Construção do Prompt ---
        const filesKnowledge = agent.knowledge_config?.text_files?.map(f => `Arquivo: ${f.name} - Link: ${f.url}`).join('\n') || '';
        
        let systemInstruction = `
        VOCÊ É: ${agent.name}, um assistente nível ${agent.level.toUpperCase()} da empresa.
        
        SUA MISSÃO:
        ${agent.prompt_instruction}
        
        CONTEXTO DO CLIENTE:
        Nome: ${lead.name || 'Não identificado'}
        Telefone: ${phone}
        
        BASE DE CONHECIMENTO (ARQUIVOS):
        ${filesKnowledge}
        
        PERSONALIDADE:
        Papel: ${agent.personality_config?.role || 'Atendente'}
        Tom: ${agent.personality_config?.tone || 'Profissional'}
        
        DIRETRIZES DE NÍVEL ${agent.level.toUpperCase()}:
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

        // --- 6. Execução com Ferramentas (Sênior) ---
        const toolsConfig = agent.level === 'senior' ? { 
            tools: [{ functionDeclarations: SENIOR_TOOLS }]
        } : {};

        let response = await ai.models.generateContent({
            model: activeModel,
            contents: fullContents,
            config: {
                systemInstruction: systemInstruction,
                temperature: agent.level === 'senior' ? 0.5 : 0.7, // Sênior mais preciso
                ...toolsConfig
            }
        });

        // --- 7. Processamento de Tools Loop ---
        let toolResponse = response;
        let functionCalls = toolResponse.functionCalls;
        let loopLimit = 0; 
        let finalReply = "";

        // Se tiver function calls (apenas Senior), processa
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
        
        // --- 8. Envio da Resposta ---
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
        console.error("❌ [SENTINEL] Erro Fatal:", error);
    }
};

export const startSentinel = () => {
    console.log("🛡️ [SENTINEL] Cérebro da IA Iniciado (Multi-Nível).");
    supabase
        .channel('ai-sentinel-global')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, processAIResponse)
        .subscribe();
};
