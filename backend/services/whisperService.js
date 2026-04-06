import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import ffmpegPath from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WhisperService {
  constructor() {
    // Ruta al ejecutable de whisper.cpp (se descargará automáticamente)
    this.whisperPath = path.join(__dirname, '../whisper-binaries/whisper.exe');
    // Usar modelo base para velocidad óptima (10-15x más rápido que small)
    this.modelPath = path.join(__dirname, '../whisper-binaries/ggml-base.bin');
    this.tempDir = path.join(__dirname, '../temp-audio');

    // Crear directorio temporal si no existe
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  // Descargar whisper.cpp precompilado si no existe
  async ensureWhisperBinary() {
    if (!fs.existsSync(this.whisperPath)) {
      console.log('Descargando whisper.cpp precompilado...');
      await this.downloadWhisperBinary();
    }

    if (!fs.existsSync(this.modelPath)) {
      console.log('Descargando modelo base (optimizado para velocidad)...');
      await this.downloadModel();
    }
  }

  // Descargar el ejecutable precompilado
  async downloadWhisperBinary() {
    const whisperDir = path.dirname(this.whisperPath);
    if (!fs.existsSync(whisperDir)) {
      fs.mkdirSync(whisperDir, { recursive: true });
    }

    // URL del ejecutable precompilado para Windows
    const url = 'https://github.com/ggerganov/whisper.cpp/releases/download/v1.5.4/whisper-bin-x64.zip';

    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      // Extraer el zip y copiar whisper.exe (omitir descarga automática por ahora)
      console.log('Por favor, descarga manualmente whisper.exe desde:');
      console.log('https://github.com/ggerganov/whisper.cpp/releases');
      console.log('Y colócalo en: backend/whisper-binaries/whisper.exe');

      throw new Error('Descarga manual requerida');
    } catch (error) {
      console.error('Error descargando whisper:', error);
      throw error;
    }
  }

  // Descargar el modelo base (optimizado para velocidad)
  async downloadModel() {
    const modelDir = path.dirname(this.modelPath);
    if (!fs.existsSync(modelDir)) {
      fs.mkdirSync(modelDir, { recursive: true });
    }

    const url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';

    try {
      console.log('Descargando modelo base (142MB, 10-15x mas rapido que small)...');
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      fs.writeFileSync(this.modelPath, buffer);
      console.log('Modelo base descargado correctamente');
    } catch (error) {
      console.error('Error descargando modelo:', error);
      throw error;
    }
  }

  // Convertir audio a formato compatible (WAV 16kHz mono)
  async convertAudioToWav(audioBuffer, filename) {
    const t0 = Date.now();
    const inputPath = path.join(this.tempDir, `${filename}.webm`);
    const outputPath = path.join(this.tempDir, `${filename}.wav`);

    // Guardar el buffer de audio
    fs.writeFileSync(inputPath, audioBuffer);

    // Validar disponibilidad de ffmpeg
    if (!ffmpegPath) {
      console.error('ffmpeg-static no encontrado. Instala la dependencia para convertir audio.');
      throw new Error('FFmpeg no disponible. Instala "ffmpeg-static" en el backend.');
    }

    return new Promise((resolve, reject) => {
      const t1 = Date.now();
      // Usar ffmpeg-static para convertir con optimizaciones de calidad
      const ffmpeg = spawn(ffmpegPath, [
        '-y',                    // Sobrescribir sin preguntar
        '-i', inputPath,         // Archivo de entrada
        '-ar', '16000',          // Sample rate 16kHz (óptimo para Whisper)
        '-ac', '1',              // Mono (1 canal)
        '-c:a', 'pcm_s16le',     // Codec PCM 16-bit little-endian
        '-af', 'highpass=f=200,lowpass=f=3000,volume=1.5', // Filtros para mejorar voz
        outputPath
      ]);

      ffmpeg.on('close', (code) => {
        const t2 = Date.now();
        if (code === 0 && fs.existsSync(outputPath)) {
          try { fs.unlinkSync(inputPath); } catch {}
          resolve(outputPath);
        } else {
          reject(new Error('Falló la conversión del audio a WAV (16 kHz mono).'));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(new Error('FFmpeg no se pudo ejecutar.'));
      });
    });
  }

  // Filtrar patrones de ruido/música de la transcripción
  cleanTranscription(text) {
    if (!text) return text;

    // Lista de patrones a eliminar (ruido común detectado por whisper)
    const noisePatterns = [
      /\[MÚSICA\]/gi,
      /\[MUSIC\]/gi,
      /\[SONIDO\]/gi,
      /\[SOUND\]/gi,
      /\[RUIDO\]/gi,
      /\[NOISE\]/gi,
      /\[AUDIO\]/gi,
      /\[MÚSICA DE FONDO\]/gi,
      /\[BACKGROUND MUSIC\]/gi,
      /\[MÚSICA AMBIENTAL\]/gi,
      /\[AMBIENT MUSIC\]/gi
    ];

    let cleaned = text;

    // Eliminar cada patrón
    noisePatterns.forEach(pattern => {
      cleaned = cleaned.replace(pattern, '');
    });

    // Eliminar cualquier texto entre corchetes que sean palabras clave de audio no deseado
    // Solo si está al final del texto (más común)
    cleaned = cleaned.replace(/\s*\[[^\]]*(?:música|music|sonido|sound|ruido|noise|audio)[^\]]*\]\s*$/gi, '');

    // Limpiar espacios múltiples y espacios al inicio/final
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
  }

  // Transcribir audio usando whisper.cpp (sin archivos .txt)
  async transcribeAudio(audioBuffer) {
    const t0 = Date.now();
    try {
      await this.ensureWhisperBinary();

      const filename = `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const audioPath = await this.convertAudioToWav(audioBuffer, filename);

      return new Promise((resolve, reject) => {
        const t1 = Date.now();

        const numThreads = Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2)));

        const args = [
          '-m', this.modelPath,
          '-f', audioPath,
          '-l', 'auto',
          '-t', numThreads.toString(),
          '-nt'
        ];
        const whisper = spawn(this.whisperPath, args);

        let output = '';
        let errorOutput = '';

        whisper.stdout.on('data', (data) => {
          output += data.toString();
        });

        whisper.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        whisper.on('close', (code) => {
          const t2 = Date.now();

          try { fs.unlinkSync(audioPath); } catch {}

          if (code !== 0) {
            console.error('Whisper error:', errorOutput);
            return reject(new Error(`whisper terminó con código ${code}: ${errorOutput}`));
          }

          const combinedOutput = output + '\n' + errorOutput;
          const lines = combinedOutput.split(/\r?\n/);
          const parts = [];
          let detectedLanguage = 'unknown';
          let languageConfidence = 0;
          
          for (const line of lines) {
            const langMatch = line.match(/(?:detected language|auto-detected language)[:\s=]+(\w+)\s*\(p\s*=\s*([\d.]+)\)/i);
            if (langMatch) {
              detectedLanguage = langMatch[1];
              languageConfidence = parseFloat(langMatch[2]);
              continue;
            }
            
            const cleaned = line.replace(/^\s*\[[^\]]+\]\s*/, '').trim();
            
            if (cleaned && 
                !cleaned.startsWith('whisper_') && 
                !cleaned.startsWith('system_info:') &&
                !cleaned.startsWith('main:') &&
                !cleaned.includes('processing') &&
                !cleaned.includes('timestamp') &&
                !cleaned.includes('samples') &&
                cleaned.length > 0) {
              parts.push(cleaned);
            }
          }
          
          let transcription = parts.join(' ').trim();

          if (!transcription) {
            return reject(new Error('No se pudo extraer texto de la salida de whisper.'));
          }

          transcription = this.cleanTranscription(transcription);
          
          resolve({ 
            text: transcription, 
            language: detectedLanguage,
            languageConfidence: languageConfidence 
          });
        });

        whisper.on('error', (error) => {
          console.error('Error ejecutando whisper:', error);
          reject(error);
        });
      });

    } catch (error) {
      console.error('Error en transcripción:', error);
      throw error;
    }
  }

  // Método público para transcribir desde el frontend
  async transcribe(audioBuffer) {
    try {
      const result = await this.transcribeAudio(audioBuffer);
      return {
        success: true,
        text: result.text,
        language: result.language || 'unknown',
        languageConfidence: result.languageConfidence || 0
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export default new WhisperService();
