
import ffmpeg from 'fluent-ffmpeg';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);

/**
 * Converte um arquivo de áudio (URL) para Buffer OGG/Opus compatível com WhatsApp PTT.
 * Usa arquivos temporários para evitar corrupção de stream.
 * @param {string} url - URL pública do arquivo de áudio (Supabase/S3)
 * @returns {Promise<Buffer>} - Buffer do arquivo convertido
 */
export const convertAudioToOpus = async (url) => {
    // Gera nomes de arquivo únicos
    const tempId = Math.random().toString(36).substring(7);
    const inputPath = path.join(os.tmpdir(), `input_${tempId}`);
    const outputPath = path.join(os.tmpdir(), `output_${tempId}.ogg`);

    try {
        // 1. Download do arquivo para o disco
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer'
        });

        await writeFile(inputPath, response.data);

        // 2. Conversão via FFmpeg (File to File)
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .toFormat('ogg')
                .audioCodec('libopus')
                .audioBitrate('64k') // Qualidade de voz
                .audioChannels(1)    // PTT deve ser Mono
                .audioFrequency(16000) // Taxa padrão do WA
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .save(outputPath);
        });

        // 3. Lê o arquivo convertido para Buffer
        const audioBuffer = await readFile(outputPath);

        // 4. Limpeza (Fire and Forget)
        cleanup(inputPath, outputPath);

        return audioBuffer;

    } catch (err) {
        console.error('[CONVERTER] Falha crítica:', err.message);
        cleanup(inputPath, outputPath);
        throw err;
    }
};

const cleanup = async (inPath, outPath) => {
    try {
        if (fs.existsSync(inPath)) await unlink(inPath);
        if (fs.existsSync(outPath)) await unlink(outPath);
    } catch (e) {
        // Ignora erro de limpeza
    }
};
