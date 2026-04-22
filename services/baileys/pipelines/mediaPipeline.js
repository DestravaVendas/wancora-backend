import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { Logger } from '../../../utils/logger.js';
import { handleMediaUpload } from '../handlers/mediaHandler.js';
import { transcribeAudio } from '../../ai/transcriber.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// =============================================================================
// TIMEOUTS DE OPERAÇÕES PESADAS
// =============================================================================
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;  // 60s para download + upload ao Supabase Storage
const TRANSCRIPTION_TIMEOUT_MS  = 45_000;  // 45s para chamada à IA de transcrição

const withTimeout = (promise, ms, fallback = null) =>
    Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(fallback), ms))
    ]);

class MediaPipeline {
    /**
     * Processa o download de mídia e enfileira transcrição se for áudio.
     * Retorna a URL da mídia salva no Supabase (ou null se falhar/timeout).
     */
    async processMedia(msgId, unwrapped, type, companyId, isRealtime, downloadMedia) {
        let mediaUrl = null;
        
        try {
            if (isRealtime || downloadMedia) {
                mediaUrl = await withTimeout(
                    handleMediaUpload(unwrapped, companyId),
                    MEDIA_DOWNLOAD_TIMEOUT_MS
                );
                
                if (!mediaUrl) {
                    Logger.error('baileys', `[PIPELINE] Timeout no download de mídia (msg ${msgId})`, {}, companyId);
                }
            }

            // Fire-and-forget: Transcrição de Áudio (não bloqueia o pipeline)
            // 🛡️ Cobre AMBOS os tipos: 'audioMessage' (gravado) e 'pttMessage' (Push-To-Talk)
            if (isRealtime && mediaUrl && (type === 'audioMessage' || type === 'pttMessage')) {
                this._transcribeAndSave(mediaUrl, msgId, companyId);
            }

        } catch (error) {
            Logger.error('baileys', `[PIPELINE] Falha crítica ao processar mídia (msg ${msgId})`, { error: error.message }, companyId);
        }

        return mediaUrl;
    }

    /**
     * Roda em background, baixa o áudio do storage e envia pra IA.
     */
    _transcribeAndSave(mediaUrl, msgId, companyId) {
        withTimeout(
            axios.get(mediaUrl, { responseType: 'arraybuffer' })
                .then(response => transcribeAudio(Buffer.from(response.data), 'audio/ogg', companyId)),
            TRANSCRIPTION_TIMEOUT_MS
        ).then(transcriptionText => {
            if (transcriptionText) {
                supabase.from('messages')
                    .update({ transcription: transcriptionText })
                    .eq('whatsapp_id', msgId)
                    .eq('company_id', companyId)
                    .then(() => {})
                    .catch(err => Logger.error('baileys', `[PIPELINE] Falha ao salvar transcrição ${msgId}`, { error: err.message }, companyId));
            }
        }).catch(err => {
            Logger.error('baileys', `[PIPELINE] Erro isolado na transcrição ${msgId}`, { error: err.message }, companyId);
        });
    }
}

export const mediaPipeline = new MediaPipeline();
