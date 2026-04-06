import express from 'express';
import multer from 'multer';
import whisperService from '../services/whisperService.js';
import auth from '../middleware/auth.js';

const router = express.Router();

// Configurar multer para manejar archivos de audio
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB máximo
  },
  fileFilter: (req, file, cb) => {
    // Aceptar solo archivos de audio
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'video/webm') {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de audio'), false);
    }
  }
});

// Endpoint para transcribir audio
router.post('/transcribe', upload.single('audio'), auth, async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No se proporcionó archivo de audio'
      });
    }

    const result = await whisperService.transcribe(req.file.buffer);

    if (result.success) {
      res.json({
        success: true,
        transcription: result.text,
        language: result.language,
        languageConfidence: result.languageConfidence
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }

  } catch (error) {
    console.error('Error en transcripción:', error.message);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
  }
});

// Endpoint para verificar el estado del servicio (público para evitar 401 en clientes sin sesión)
router.get('/status', async (req, res) => {
  try {
    // Verificar si whisper.cpp está disponible
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    
    const whisperPath = path.join(__dirname, '../whisper-binaries/whisper.exe');
    const modelPath = path.join(__dirname, '../whisper-binaries/ggml-small.bin');
    
    const whisperExists = fs.existsSync(whisperPath);
    const modelExists = fs.existsSync(modelPath);
    
    res.json({
      success: true,
      whisper_available: whisperExists,
      model_available: modelExists,
      ready: whisperExists && modelExists
    });
    
  } catch (error) {
    console.error('Error verificando estado:', error);
    res.status(500).json({
      success: false,
      error: 'Error verificando estado del servicio'
    });
  }
});

export default router; 