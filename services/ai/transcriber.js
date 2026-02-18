
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

const getAIClient = async (companyId) => {
    let apiKey = process.env.API_KEY;
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

export const transcribeAudio = async (audioBuffer, mimeType, companyId) => {
    try {
        const genAI = await getAIClient(companyId);
        if (!genAI) return null;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // SDK Estável: Usa array de parts com inlineData
        const result = await model.generateContent([
            {
                inlineData: {
                    mimeType: mimeType || 'audio/ogg',
                    data: audioBuffer.toString("base64")
                }
            },
            { text: "Transcreva este áudio exatamente como foi dito. Apenas o texto." }
        ]);

        return result.response.text().trim();
    } catch (error) {
        console.error("❌ [TRANSCRIBER] Falha:", error.message);
        return null;
    }
};
