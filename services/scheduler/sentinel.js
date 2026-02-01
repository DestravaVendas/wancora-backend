
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { sendMessage } from "../baileys/sender.js";
import { getSessionId } from "../../controllers/whatsappController.js";
import axios from 'axios';

// Cliente Supabase Service Role (Realtime)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// Mapa para evitar respostas duplicadas em curto prazo (Debounce)
const processingLock = new Set();

// Cache de clientes IA para evitar recriar a cada mensagem
const aiInstances = new Map();

/**
 * Factory Dinâmica de IA
 */
const getAIClient = (apiKey) => {
    if (!apiKey) return null;
    if (!aiInstances.has(apiKey)) {
        aiInstances.set(apiKey, new GoogleGenAI({ apiKey }));
    }
    return aiInstances.get(apiKey);
};

// Helper para baixar áudio e converter para Base64
const fetchAudioAsBase64 = async (url) => {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data).toString('base64');
    } catch (e) {
        console.error("[SENTINEL] Falha ao baixar audio:", e.message);
        return null;
    }
};

/**
 * TOOLS DEFINITION: Ferramentas que a IA pode usar
 */
const TOOLS = [
    {
        name: "search_files",
        description: "Busca arquivos no Google Drive da empresa pelo nome. Use isso quando o usuário pedir documentos, fotos, catálogos ou preços.",
        parameters: {
            type: "OBJECT",
            properties: {
                query: {
                    type: "STRING",
                    description: "Termo de busca (ex: 'catálogo', 'preços', 'foto da loja')"
                }
            },
            required: ["query"]
        }
    },
    {
        name: "send_file",
        description: "Envia um arquivo específico para o usuário. Use após encontrar o arquivo correto com search_files.",
        parameters: {
            type: "OBJECT",
            properties: {
                google_id: {
                    type: "STRING",
                    description: "O ID do arquivo (google_id) retornado pela busca."
                }
            },
            required: ["google_id"]
        }
    }
];

const processAIResponse = async (payload) => {
    const { id, content, remote_jid, company_id, from_me, message_type, media_url, created_at } = payload.new;

    if (from_me) return; 
    
    const isText = message_type === 'text';
    const isAudio = message_type === 'audio' || message_type === 'ptt' || message_type === 'voice';
    
    if (!isText && !isAudio) return;
    if (isText && !content) return;
    if (isAudio && !media_url) return;

    // Horizonte de Eventos
    const msgTime = new Date(created_at).getTime();
    const now = Date.now();
    if (now - msgTime > 2 * 60 * 1000) return;

    // Debounce
    const lockKey = `${remote_jid}-${id}`;
    if (processingLock.has(lockKey)) return;
    processingLock.add(lockKey);
    setTimeout(() => processingLock.delete(lockKey), 10000); 

    // Verificações de Lead e Bot Status
    const phone = remote_jid.split('@')[0];
    const { data: lead } = await supabase
        .from('leads')
        .select('id, name, bot_status')
        .eq('company_id', company_id)
        .eq('phone', phone)
        .maybeSingle();

    if (!lead || lead.bot_status !== 'active') return;

    const [agentRes, companyRes] = await Promise.all([
        supabase.from('agents').select('*').eq('company_id', company_id).eq('is_active', true).maybeSingle(),
        supabase.from('companies').select('ai_config').eq('id', company_id).single()
    ]);

    const agent = agentRes.data;
    const companyConfig = companyRes.data?.ai_config;

    if (!agent) return; 

    // Auto-Handoff Check
    if (isText) {
        const stopWords = agent.stop_words || ['falar com humano', 'atendente', 'humano', 'suporte'];
        const lowerContent = content.toLowerCase();
        if (stopWords.some(word => lowerContent.includes(word.toLowerCase()))) {
            console.log(`🛑 [SENTINEL] Handoff detectado.`);
            await supabase.from('leads').update({ bot_status: 'paused' }).eq('id', lead.id);
            const sessionId = await getSessionId(company_id);
            if (sessionId) await sendMessage({ sessionId, to: remote_jid, type: 'text', content: "Transferindo para um humano..." });
            return; 
        }
    }

    try {
        let activeApiKey = companyConfig?.apiKey || process.env.API_KEY;
        let activeModel = companyConfig?.model || agent.model || 'gemini-3-flash-preview';

        if (!activeApiKey) return;

        const ai = getAIClient(activeApiKey);

        // Carregar Contexto
        const { data: history } = await supabase
            .from('messages')
            .select('content, from_me, message_type')
            .eq('company_id', company_id)
            .eq('remote_jid', remote_jid)
            .neq('id', id)
            .order('created_at', { ascending: false })
            .limit(10); 

        const chatHistory = (history || []).reverse().map(m => ({
            role: m.from_me ? 'model' : 'user',
            parts: [{ text: m.message_type === 'text' ? (m.content || "") : "[Arquivo]" }]
        }));

        const currentParts = [];
        if (isAudio) {
            const audioBase64 = await fetchAudioAsBase64(media_url);
            if (audioBase64) {
                currentParts.push({ inlineData: { mimeType: "audio/mp3", data: audioBase64 } });
                currentParts.push({ text: "O usuário enviou este áudio." });
            } else return;
        } else {
            currentParts.push({ text: content });
        }

        const fullContents = [...chatHistory, { role: 'user', parts: currentParts }];

        const systemInstruction = `
        ${agent.prompt_instruction}
        
        CLIENTE: ${lead.name} (${lead.phone})
        
        BASE DE CONHECIMENTO:
        ${agent.knowledge_base}
        
        DIRETRIZES:
        - Responda em texto curto e natural.
        - Se o usuário pedir um arquivo (catálogo, foto, pdf), USE A FERRAMENTA search_files.
        - Se encontrar o arquivo, USE A FERRAMENTA send_file para enviá-lo.
        - NÃO envie links do Google Drive, use a ferramenta send_file para envio nativo.
        `;

        // ---------------------------------------------------------
        // GEMINI TOOL USE LOOP
        // ---------------------------------------------------------
        
        // Configuração com Tools
        const toolConfig = { 
            tools: [{ functionDeclarations: TOOLS }]
        };

        // 1. Primeira Chamada
        let response = await ai.models.generateContent({
            model: activeModel,
            contents: fullContents,
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.7,
                ...toolConfig
            }
        });

        // Loop de processamento de Tools (Multi-Turn)
        let toolResponse = response;
        let functionCalls = toolResponse.functionCalls;

        while (functionCalls && functionCalls.length > 0) {
            const parts = [];

            for (const call of functionCalls) {
                console.log(`🔧 [AI TOOL] Chamando: ${call.name} args:`, call.args);
                let result = {};

                // --- EXECUÇÃO DAS TOOLS ---
                if (call.name === 'search_files') {
                    const query = call.args.query;
                    // Chama RPC do Supabase
                    const { data: files } = await supabase.rpc('search_drive_files', { 
                        p_company_id: company_id, 
                        p_query: query,
                        p_limit: 5 
                    });
                    
                    if (files && files.length > 0) {
                        result = { found: true, files: files.map(f => ({ google_id: f.google_id, name: f.name, type: f.mime_type })) };
                    } else {
                        result = { found: false, message: "Nenhum arquivo encontrado com esse nome." };
                    }
                } 
                else if (call.name === 'send_file') {
                    const googleId = call.args.google_id;
                    const sessionId = await getSessionId(company_id);
                    if (sessionId) {
                        // Dispara envio Assíncrono via Sender (Não bloqueia a IA)
                        // O Sender agora sabe lidar com driveFileId
                        sendMessage({
                            sessionId,
                            to: remote_jid,
                            driveFileId: googleId, // ID Real do Google
                            companyId
                        }).catch(err => console.error("Erro ao enviar arquivo via IA:", err));
                        
                        result = { success: true, message: "Arquivo enviado para o chat." };
                    } else {
                        result = { success: false, message: "WhatsApp desconectado." };
                    }
                }

                // Adiciona resposta da função ao histórico da conversa para a próxima volta
                parts.push({
                    functionResponse: {
                        name: call.name,
                        response: { result: result }
                    }
                });
            }

            // Adiciona a resposta da função ao contexto
            fullContents.push({ role: "model", parts: toolResponse.candidates[0].content.parts }); // O que a IA pediu
            fullContents.push({ role: "function", parts: parts }); // O que respondemos

            // 2. Chamada Subsequente (Com o resultado da função)
            toolResponse = await ai.models.generateContent({
                model: activeModel,
                contents: fullContents,
                config: {
                    systemInstruction: systemInstruction,
                    temperature: 0.7,
                    ...toolConfig
                }
            });
            
            // Verifica se a IA quer chamar mais funções
            functionCalls = toolResponse.functionCalls;
        }

        // Resposta Final (Texto)
        const finalReply = toolResponse.text;
        
        if (finalReply) {
            const sessionId = await getSessionId(company_id);
            if (sessionId) {
                await sendMessage({
                    sessionId,
                    to: remote_jid,
                    type: 'text',
                    content: finalReply
                });
            }
        }

    } catch (error) {
        console.error("❌ [SENTINEL] Erro IA:", error);
    }
};

export const startSentinel = () => {
    console.log("🛡️ [SENTINEL] Agente de IA iniciado (Tools Enabled).");
    supabase
        .channel('ai-sentinel-global')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, processAIResponse)
        .subscribe();
};
