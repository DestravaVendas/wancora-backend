
import ffmpeg from 'fluent-ffmpeg';
import axios from 'axios';
import { PassThrough } from 'stream';

/**
 * Converte um arquivo de áudio (URL) para Buffer OGG/Opus compatível com WhatsApp PTT.
 * @param {string} url - URL pública do arquivo de áudio (Supabase/S3)
 * @returns {Promise<Buffer>} - Buffer do arquivo convertido
 */
export const convertAudioToOpus = async (url) => {
    return new Promise(async (resolve, reject) => {
        try {
            // 1. Baixa o arquivo original como Stream
            const response = await axios({
                method: 'GET',
                url: url,
                responseType: 'stream'
            });

            // 2. Cria streams de passagem
            const outStream = new PassThrough();
            const chunks = [];

            // 3. Coleta os dados convertidos
            outStream.on('data', (chunk) => chunks.push(chunk));
            outStream.on('end', () => resolve(Buffer.concat(chunks)));
            outStream.on('error', (err) => reject(err));

            // 4. Inicia conversão FFmpeg
            ffmpeg(response.data)
                .toFormat('ogg')
                .audioCodec('libopus')
                .audioBitrate('64k') // 64k é suficiente para voz e economiza banda
                .audioChannels(1)    // PTT deve ser Mono
                .audioFrequency(16000) // Taxa de amostragem padrão do WA
                .on('error', (err) => {
                    console.error('[FFMPEG] Erro na conversão:', err.message);
                    reject(err);
                })
                .pipe(outStream, { end: true });

        } catch (err) {
            console.error('[CONVERTER] Falha no download ou setup:', err.message);
            reject(err);
        }
    });
};
