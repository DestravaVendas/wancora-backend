
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
 * Converte áudio para OGG/Opus, gera Waveform e extrai Duração.
 * @param {string} url - URL do áudio
 * @returns {Promise<{ buffer: Buffer, waveform: number[], duration: number }>}
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

        // 3. Extrair Duração Real (Metadado Crítico para Waveform)
        const duration = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(outputPath, (err, metadata) => {
                if (err) resolve(0); // Fallback se falhar
                else resolve(Math.ceil(metadata.format.duration || 0));
            });
        });

        const audioBuffer = await readFile(outputPath);

        // 4. Gerar Waveform (Padrão WhatsApp: 64 barras)
        const waveform = generateFakeWaveform(audioBuffer.length);

        cleanup(inputPath, outputPath);

        return { buffer: audioBuffer, waveform, duration };

    } catch (err) {
        console.error('[CONVERTER] Erro:', err.message);
        cleanup(inputPath, outputPath);
        throw err;
    }
};

// Gera um padrão visual de onda sonora para o WhatsApp (64 samples)
const generateFakeWaveform = (seed) => {
    const length = 64; 
    const waveform = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        // Gera valores variados para parecer voz natural (picos e vales)
        const val = Math.floor(Math.random() * 50) + (i % 2 === 0 ? 30 : 10);
        waveform[i] = val;
    }
    return Array.from(waveform); 
};

const cleanup = async (inPath, outPath) => {
    try {
        if (fs.existsSync(inPath)) await unlink(inPath);
        if (fs.existsSync(outPath)) await unlink(outPath);
    } catch (e) {}
};
