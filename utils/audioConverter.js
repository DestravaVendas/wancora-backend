
import ffmpeg from 'fluent-ffmpeg';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Converte um arquivo de áudio (URL) para Buffer OGG/Opus compatível com WhatsApp PTT.
 * Usa sistema de arquivos temporário e flags de limpeza de metadados.
 * @param {string} url - URL pública do arquivo de áudio (Supabase/S3)
 * @returns {Promise<Buffer>} - Buffer do arquivo convertido
 */
export const convertAudioToOpus = async (url) => {
    // Gera nomes de arquivo únicos para evitar colisão em concorrência
    const tempId = Math.random().toString(36).substring(7);
    const inputPath = path.join(os.tmpdir(), `input_${tempId}`);
    const outputPath = path.join(os.tmpdir(), `output_${tempId}.ogg`);

    try {
        // 1. Download do arquivo original via Stream
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream'
        });

        // Salva o stream no disco
        const writer = fs.createWriteStream(inputPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // 2. Conversão Robusta via FFmpeg
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .toFormat('ogg')
                .audioCodec('libopus')
                .audioBitrate('64k')      // 64kbps é o padrão ideal para voz no WA
                .audioChannels(1)         // Mono é OBRIGATÓRIO para gerar a waveform verde
                .audioFrequency(16000)    // 16kHz (Wideband) para clareza de voz
                .outputOptions([
                    '-avoid_negative_ts make_zero', // Corrige timestamps negativos no início
                    '-map_metadata -1',             // Remove capas, tags e lixo de metadados
                    '-application voip'             // Otimiza o encoder Opus para fala humana
                ])
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .save(outputPath);
        });

        // 3. Lê o arquivo convertido para Buffer
        const audioBuffer = fs.readFileSync(outputPath);

        // 4. Limpeza (Fire and Forget)
        cleanup(inputPath, outputPath);

        return audioBuffer;

    } catch (err) {
        console.error('[CONVERTER] Falha crítica na conversão:', err.message);
        cleanup(inputPath, outputPath);
        throw err;
    }
};

const cleanup = (inPath, outPath) => {
    try {
        if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (e) {
        // Ignora erros de limpeza
    }
};
