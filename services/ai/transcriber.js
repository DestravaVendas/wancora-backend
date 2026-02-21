import { GoogleGenerativeAI } from "@google/generative-ai";
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
    return new GoogleGenerativeAI(apiKey);
};

/**
 * Transcreve um buffer de áudio usando Gemini 2.5 Flash
 * @param {Buffer} audioBuffer - Buffer do arquivo de áudio (MP3/OGG/WAV)
 * @param {string} mimeType - Mime type do áudio
 * @param {string} companyId - ID da empresa para buscar a chave correta
 */
export const transcribeAudio = async (audioBuffer, mimeType, companyId) => {
    try {
        const genAI = await getAIClient(companyId);
        if (!genAI) {
            console.error("❌ [TRANSCRIBER] Chave API não encontrada.");
            return null;
        }

        // Utiliza o modelo 2.0 flash de produção
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash",
            // Mantemos a temperatura baixa para garantir que ele não invente palavras
            generationConfig: {
                temperature: 0.2, 
                maxOutputTokens: 1000
            }
        });

        // Formatação correta para a biblioteca @google/generative-ai
        const audioData = {
            inlineData: {
                mimeType: mimeType || 'audio/ogg',
                data: audioBuffer.toString("base64")
            }
        };

        const prompt = "Transcreva este áudio exatamente como foi dito. Se for apenas ruído ou silêncio, retorne [Inaudível]. Apenas o texto, sem formatação.";

        // A sintaxe correta para envio multimodal nesta biblioteca
        const result = await model.generateContent([prompt, audioData]);
        
        return result.response.text().trim();

    } catch (error) {
        console.error("❌ [TRANSCRIBER] Falha na transcrição:", error.message);
        return null;
    }
};
