
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

const processAIResponse = async (payload) => {
    const { id, content, remote_jid, company_id, from_me, message_type, media_url, created_at } = payload.new;

    // 1. Filtros de Segurança Básicos
    if (from_me) return; 
    
    // Aceita texto e áudio agora
    const isText = message_type === 'text';
    const isAudio = message_type === 'audio' || message_type === 'ptt' || message_type === 'voice';
    
    if (!isText && !isAudio) return;
    if (isText && !content) return;
    if (isAudio && !media_url) return;

    // 🔴 HORIZONTE DE EVENTOS (CRÍTICO)
    // Ignora mensagens antigas (> 2 minutos) que entraram via Sync de Histórico
    const msgTime = new Date(created_at).getTime();
    const now = Date.now();
    if (now - msgTime > 2 * 60 * 1000) {
        return;
    }

    // Debounce
    const lockKey = `${remote_jid}-${id}`;
    if (processingLock.has(lockKey)) return;
    processingLock.add(lockKey);
    setTimeout(() => processingLock.delete(lockKey), 10000); 

    // 2. Verificar se o Lead existe e tem Bot Ativo
    const phone = remote_jid.split('@')[0];
    const { data: lead } = await supabase
        .from('leads')
        .select('id, name, bot_status')
        .eq('company_id', company_id)
        .eq('phone', phone)
        .maybeSingle();

    if (!lead || lead.bot_status !== 'active') return;

    // 3. Buscar Configuração do Agente e Empresa
    const [agentRes, companyRes] = await Promise.all([
        supabase.from('agents').select('*').eq('company_id', company_id).eq('is_active', true).maybeSingle(),
        supabase.from('companies').select('ai_config').eq('id', company_id).single()
    ]);

    const agent = agentRes.data;
    const companyConfig = companyRes.data?.ai_config;

    if (!agent) return; 

    // 🔴 AUTO-HANDOFF CHECK (Text Only)
    if (isText) {
        const stopWords = agent.stop_words || ['falar com humano', 'atendente', 'humano', 'suporte'];
        const lowerContent = content.toLowerCase();
        const shouldStop = stopWords.some(word => lowerContent.includes(word.toLowerCase()));

        if (shouldStop) {
            console.log(`🛑 [SENTINEL] Handoff detectado para ${lead.name}. Pausando robô.`);
            await supabase.from('leads').update({ bot_status: 'paused' }).eq('id', lead.id);
            const sessionId = await getSessionId(company_id);
            if (sessionId) {
                await sendMessage({
                    sessionId,
                    to: remote_jid,
                    type: 'text',
                    content: "Entendido. Vou transferir você para um de nossos especialistas. Um momento."
                });
            }
            return; 
        }
    }

    try {
        console.log(`🤖 [SENTINEL] IA Acionada para ${lead.name} (${message_type})...`);

        let activeApiKey = companyConfig?.apiKey || process.env.API_KEY;
        // Se for áudio, força um modelo que suporte multimodal se o configurado for apenas texto (opcional, Gemini 3 Flash suporta ambos)
        let activeModel = companyConfig?.model || agent.model || 'gemini-3-flash-preview';

        if (!activeApiKey) {
            console.error("❌ [SENTINEL] Erro: Nenhuma API Key encontrada.");
            return;
        }

        const ai = getAIClient(activeApiKey);

        // 4. Carregar Contexto (Histórico Recente)
        const { data: history } = await supabase
            .from('messages')
            .select('content, from_me, message_type')
            .eq('company_id', company_id)
            .eq('remote_jid', remote_jid)
            .neq('id', id) // Exclui a atual para não duplicar no contexto
            .order('created_at', { ascending: false })
            .limit(10); 

        const chatHistory = (history || []).reverse().map(m => ({
            role: m.from_me ? 'model' : 'user',
            parts: [{ text: m.message_type === 'text' ? (m.content || "") : "[Áudio/Mídia]" }]
        }));

        // 5. Preparar Input Atual (Texto ou Áudio)
        const currentParts = [];
        if (isAudio) {
            const audioBase64 = await fetchAudioAsBase64(media_url);
            if (audioBase64) {
                currentParts.push({
                    inlineData: {
                        mimeType: "audio/mp3", // Gemini aceita MP3/WAV/AAC. O backend converte PTT para MP4/OGG, mas mime genérico audio/* costuma passar
                        data: audioBase64
                    }
                });
                // Instrução implícita para o modelo entender que recebeu um áudio
                currentParts.push({ text: "O usuário enviou este áudio. Ouça e responda em texto." });
            } else {
                return; // Falha no download
            }
        } else {
            currentParts.push({ text: content });
        }

        const fullContents = [...chatHistory, { role: 'user', parts: currentParts }];

        // 6. System Prompt
        const systemInstruction = `
        ${agent.prompt_instruction}
        
        INFORMAÇÕES DO CLIENTE ATUAL:
        Nome: ${lead.name}
        Telefone: ${lead.phone}
        
        BASE DE CONHECIMENTO:
        ${agent.knowledge_base}
        
        DIRETRIZES:
        - Você é capaz de ouvir áudios e deve transcrevê-los mentalmente para entender o contexto.
        - Responda SEMPRE em texto.
        - Mantenha o tom natural de WhatsApp.
        - Se não souber ou não entender o áudio, sugira falar com um humano.
        `;

        // 7. Generate
        const response = await ai.models.generateContent({
            model: activeModel,
            contents: fullContents,
            config: {
                systemInstruction: systemInstruction,
                maxOutputTokens: 400, 
                temperature: 0.7 
            }
        });

        const replyText = response.text;

        if (replyText) {
            const sessionId = await getSessionId(company_id);
            if (sessionId) {
                await new Promise(r => setTimeout(r, isAudio ? 4000 : 2000)); // Delay maior para áudio (simular 'ouvindo')
                
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
        console.error("❌ [SENTINEL] Erro IA:", error.message);
    }
};

export const startSentinel = () => {
    console.log("🛡️ [SENTINEL] Agente de IA iniciado (Multimodal Ready).");
    
    supabase
        .channel('ai-sentinel-global')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, processAIResponse)
        .subscribe();
};
