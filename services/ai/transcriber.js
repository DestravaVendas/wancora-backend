
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

// Cliente Supabase para buscar chaves se necessário
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const getAIClient = async (companyId) => {
    let apiKey = process.env.API_KEY; // Fallback Global

    if (companyId) {
        const { data: company } = await supabase
            .from('companies')
            .select('ai_config')
            .eq('id', companyId)
            .single();
        
        if (company?.ai_config?.apiKey) {
            apiKey = company.ai_config.apiKey;
        }
    }

    if (!apiKey) return null;
    return new GoogleGenAI({ apiKey });
};

/**
 * Transcreve um buffer de áudio usando Gemini Flash (Rápido e barato)
 * @param {Buffer} audioBuffer - Buffer do arquivo de áudio (MP3/OGG/WAV)
 * @param {string} mimeType - Mime type do áudio
 * @param {string} companyId - ID da empresa para buscar a chave correta
 */
export const transcribeAudio = async (audioBuffer, mimeType, companyId) => {
    try {
        const ai = await getAIClient(companyId);
        if (!ai) return null;

        // Converte Buffer para Base64
        const audioBase64 = audioBuffer.toString('base64');

        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash', // Modelo de Produção Estável
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType: mimeType || 'audio/ogg',
                                data: audioBase64
                            }
                        },
                        { text: "Transcreva este áudio exatamente como foi dito. Se for apenas ruído ou silêncio, retorne [Inaudível]. Apenas o texto, sem formatação." }
                    ]
                }
            ],
            config: {
                temperature: 0.2, // Baixa criatividade para fidelidade
                maxOutputTokens: 1000
            }
        });

        return response.text ? response.text.trim() : null;

    } catch (error) {
        console.error("❌ [TRANSCRIBER] Falha na transcrição:", error.message);
        return null;
    }
};
