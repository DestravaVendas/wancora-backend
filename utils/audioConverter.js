
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

        // 2. Conversão FFmpeg (Strict PTT Settings)
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .toFormat('ogg')
                .audioCodec('libopus')
                .audioBitrate('64k') // Bitrate fixo ideal para voz
                .audioChannels(1)    // CRÍTICO: Mono é obrigatório para PTT visual
                .audioFrequency(16000) // 16kHz (Wideband)
                .outputOptions([
                    '-avoid_negative_ts make_zero',
                    '-map_metadata -1', // Remove metadados que atrapalham o WA
                    '-application voip' // Otimiza compressão para voz
                ])
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });

        // 3. Extrair Duração Real (Metadado Crítico para Waveform)
        const duration = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(outputPath, (err, metadata) => {
                if (err || !metadata || !metadata.format || !metadata.format.duration) {
                    // Fallback: Se ffprobe falhar, assume 10s (melhor que 0)
                    resolve(0);
                } else {
                    resolve(Math.ceil(metadata.format.duration));
                }
            });
        });

        const audioBuffer = await readFile(outputPath);

        // Fallback de duração se o ffprobe retornou 0 (baseado em bitrate 64k)
        // Tamanho (bytes) * 8 / 64000 = segundos aproximados
        const finalDuration = duration > 0 ? duration : Math.ceil((audioBuffer.length * 8) / 64000);

        // 4. Gerar Waveform (Padrão WhatsApp: 64 samples)
        const waveform = generateFakeWaveform();

        cleanup(inputPath, outputPath);

        return { buffer: audioBuffer, waveform, duration: finalDuration };

    } catch (err) {
        console.error('[CONVERTER] Erro:', err.message);
        cleanup(inputPath, outputPath);
        throw err;
    }
};

// Gera um padrão visual de onda sonora para o WhatsApp (64 samples)
// Retorna array de inteiros (0-100)
const generateFakeWaveform = () => {
    const length = 64; 
    const waveform = new Array(length);
    for (let i = 0; i < length; i++) {
        // Simula picos de voz: valores aleatórios mas com "corpo" (mínimo 10)
        // O WhatsApp espera bytes (0-255), mas visualmente 0-100 funciona bem
        const val = Math.floor(Math.random() * 80) + 10;
        waveform[i] = val;
    }
    return waveform; 
};

const cleanup = async (inPath, outPath) => {
    try {
        if (fs.existsSync(inPath)) await unlink(inPath);
        if (fs.existsSync(outPath)) await unlink(outPath);
    } catch (e) {}
};
