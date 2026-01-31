
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
 * Converte áudio para OGG/Opus e gera Waveform.
 * @param {string} url - URL do áudio
 * @returns {Promise<{ buffer: Buffer, waveform: number[] }>}
 */
export const convertAudioToOpus = async (url) => {
    const tempId = Math.random().toString(36).substring(7);
    const inputPath = path.join(os.tmpdir(), `input_${tempId}`);
    const outputPath = path.join(os.tmpdir(), `output_${tempId}.ogg`);

    try {
        // 1. Download
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer'
        });

        await writeFile(inputPath, response.data);

        // 2. Conversão FFmpeg
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .toFormat('ogg')
                .audioCodec('libopus')
                .audioBitrate('64k')
                .audioChannels(1)
                .audioFrequency(16000)
                .outputOptions([
                    '-avoid_negative_ts make_zero',
                    '-map_metadata -1',
                    '-application voip'
                ])
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });

        const audioBuffer = await readFile(outputPath);

        // 3. Gerar Waveform (Simplificado)
        // O WhatsApp espera um array de 64 bytes (inteiros 0-99) representando a amplitude.
        // Extrair isso precisamente com FFmpeg exige parsing complexo de PCM.
        // Vamos gerar um waveform pseudo-randômico baseado no tamanho do buffer para performance e efeito visual.
        // Isso garante que a mensagem PTT tenha a "aparência" correta.
        const waveform = generateFakeWaveform(audioBuffer.length);

        cleanup(inputPath, outputPath);

        return { buffer: audioBuffer, waveform };

    } catch (err) {
        console.error('[CONVERTER] Erro:', err.message);
        cleanup(inputPath, outputPath);
        throw err;
    }
};

// Gera um padrão visual de onda sonora para o WhatsApp
// (Extração real exigiria decodificar o PCM completo, o que é lento para Node puro)
const generateFakeWaveform = (seed) => {
    const length = 64; // WhatsApp usa ~64 barras
    const waveform = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        // Gera valores entre 0 e 100 com alguma variação "natural"
        const val = Math.floor(Math.random() * 60) + 10;
        waveform[i] = val;
    }
    return Array.from(waveform); // Retorna array normal para JSON
};

const cleanup = async (inPath, outPath) => {
    try {
        if (fs.existsSync(inPath)) await unlink(inPath);
        if (fs.existsSync(outPath)) await unlink(outPath);
    } catch (e) {}
};
