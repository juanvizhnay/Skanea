import fal from '@fal-ai/serverless-client';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import os from 'os';
import FileMetadata from '../utils/FileMetadata.js';

// Configurar Fal.ai
fal.config({
  credentials: process.env.FAL_API_KEY
});

class ImageService {
  constructor() {
    // Usar carpeta de biblioteca local en Documentos del usuario
    this.exportsDir = this.getLibraryPath();
    this.ensureExportsDir();
  }

  // Obtener la ruta de la biblioteca
  getLibraryPath() {
    // 1. Primero revisar si hay configuración guardada por el usuario
    const configPath = path.join(process.cwd(), 'library-config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.libraryPath && fs.existsSync(config.libraryPath)) {
          return config.libraryPath;
        }
      } catch (err) {
        console.warn('Error leyendo library-config.json:', err.message);
      }
    }

    // 2. Revisar variable de entorno (para usuarios avanzados)
    const customPath = process.env.SKANEA_LIBRARY_PATH;
    if (customPath && fs.existsSync(customPath)) {
      return customPath;
    }

    // 3. Ruta por defecto: Documentos/Skanea
    const homeDir = os.homedir();
    const defaultPath = path.join(homeDir, 'Documents', 'Skanea');

    return defaultPath;
  }

  ensureExportsDir() {
    if (!fs.existsSync(this.exportsDir)) {
      fs.mkdirSync(this.exportsDir, { recursive: true });
      console.log('Carpeta de biblioteca creada en:', this.exportsDir);
    }
  }

  // Generar nombre único si el archivo ya existe (estilo Windows)
  // Ejemplo: imagen.jpg → imagen (1).jpg → imagen (2).jpg
  getUniqueFilename(baseName, extension) {
    const baseFilePath = path.join(this.exportsDir, `${baseName}.${extension}`);

    // Si no existe, usar el nombre original
    if (!fs.existsSync(baseFilePath)) {
      return { name: baseName, path: baseFilePath };
    }

    // Si existe, buscar un número disponible
    let counter = 1;
    let uniqueName = `${baseName} (${counter})`;
    let uniquePath = path.join(this.exportsDir, `${uniqueName}.${extension}`);

    while (fs.existsSync(uniquePath)) {
      counter++;
      uniqueName = `${baseName} (${counter})`;
      uniquePath = path.join(this.exportsDir, `${uniqueName}.${extension}`);
    }

    console.log(`[UNIQUE-NAME] Imagen "${baseName}.${extension}" ya existe, usando "${uniqueName}.${extension}"`);
    return { name: uniqueName, path: uniquePath };
  }

  // Genera un nombre corto y descriptivo del prompt (tema principal)
  deriveFilenameFromPrompt(text) {
    if (!text || typeof text !== 'string') return 'imagen_skanea';
    const raw = text.toLowerCase();
    // quitar verbos/comandos comunes y destino (drive)
    let s = raw
      .replace(/\b(genera|generar|crea|crear|haz|hacer|dame|quiero|puedes|podr[íi]as|sube|subir|subirlo|subirla|subirlos|subirlas)\b/gi,'')
      .replace(/\b(una|un|el|la|los|las|en|de|del|con|sobre|para|mi|tu|su)\b/gi,'')
      .replace(/\b(google\s+)?drive\b/gi,'')
      .replace(/\s+/g,' ').trim();
    // extraer 2-4 palabras clave significativas
    const stop = new Set(['un','una','en','de','del','la','el','los','las','y','e','con','sobre','para']);
    const words = s.split(/\s+/)
      .filter(w => w && w.length > 2 && !/^\d+$/.test(w) && !stop.has(w))
      .slice(0, 4);
    if (words.length === 0) return 'imagen_skanea';
    return words.join('_').replace(/[^a-z0-9_]/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,'');
  }

  async generateImage(prompt, filename = null, conversationId = null, autoSaveFiles = true) {
    try {
      // Generar nombre único si no se proporciona
      if (!filename) filename = this.deriveFilenameFromPrompt(prompt);

      // Guardar nombre base limpio (sin extensión ni ID)
      const baseCleanName = filename;

      // Generar ID único interno (para tracking, NO para el nombre del archivo)
      const fileId = conversationId ? conversationId.slice(-8) : Date.now().toString().slice(-8);

      // Obtener nombre único si el archivo ya existe (estilo Windows)
      const uniqueFile = this.getUniqueFilename(baseCleanName, 'jpg');
      const finalFileName = uniqueFile.name;

      // Intentar con Fal.ai primero, fallback a Hugging Face si falla
      let result;
      try {
        result = await fal.subscribe('fal-ai/flux/dev', {
          input: {
            prompt: prompt,
            image_size: 'landscape_4_3',
            num_inference_steps: 28,
            guidance_scale: 3.5,
            num_images: 1,
            enable_safety_checker: true
          }
        });
      } catch (falError) {
        console.warn('Fal.ai falló:', falError.message);

        if (falError.message.includes('Exhausted balance') || falError.message.includes('Forbidden')) {
          console.log('Sin créditos en Fal.ai, usando Hugging Face gratis...');

          // Fallback a Hugging Face (gratis)
          try {
            const hfResponse = await fetch('https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-2-1', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                inputs: prompt,
                parameters: {
                  guidance_scale: 7.5,
                  num_inference_steps: 20
                }
              })
            });

            if (!hfResponse.ok) {
              throw new Error(`Hugging Face error: ${hfResponse.status}`);
            }

            const imageBlob = await hfResponse.blob();
            const imageBuffer = Buffer.from(await imageBlob.arrayBuffer());

            // Simular el formato de respuesta de Fal.ai
            result = {
              images: [{
                url: 'data:image/jpeg;base64,' + imageBuffer.toString('base64'),
                width: 768,
                height: 768
              }]
            };

          } catch (hfError) {
            console.error('Hugging Face también falló, usando imagen placeholder...');
            // Fallback final - imagen placeholder
            result = {
              images: [{
                url: 'https://picsum.photos/800/600?random=' + Date.now(),
                width: 800,
                height: 600
              }]
            };
          }
        } else {
          throw falError; // Re-throw si es otro tipo de error
        }
      }

      const imageUrl = result.images[0].url;

      let imageBuffer;

      // Si la imagen viene como data URL (base64), extraer el buffer directamente
      if (imageUrl.startsWith('data:image/')) {
        const base64Data = imageUrl.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        // Si es una URL normal, descargarla
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(`Error descargando imagen: ${response.status}`);
        }
        imageBuffer = Buffer.from(await response.arrayBuffer());
      }

      // Generar preview de alta calidad
      const blurBuffer = await sharp(imageBuffer)
        .resize(400, 300, { fit: 'cover' })
        .jpeg({ quality: 90 })
        .toBuffer();

      const blurDataUrl = `data:image/jpeg;base64,${blurBuffer.toString('base64')}`;
      const fileSize = imageBuffer.length;

      // Si auto-save está activado: guardar en disco
      // Si está desactivado: devolver buffer en memoria
      if (autoSaveFiles) {
        const originalPath = path.join(this.exportsDir, `${finalFileName}.jpg`);
        fs.writeFileSync(originalPath, imageBuffer);

        const blurPath = path.join(this.exportsDir, `${finalFileName}_preview.jpg`);
        fs.writeFileSync(blurPath, blurBuffer);

        // Crear FileMetadata
        const fileMetadata = new FileMetadata(
          finalFileName,
          'jpg',
          fileId,
          originalPath
        );

        return {
          success: true,
          filePath: originalPath,
          previewPath: blurPath,
          previewDataUrl: blurDataUrl,
          filename: fileMetadata.displayName,
          displayName: fileMetadata.displayName,
          metadata: fileMetadata.toJSON(),
          size: fileSize,
          width: result.images[0].width,
          height: result.images[0].height,
          prompt: prompt,
          message: imageUrl.startsWith('data:image/') ?
            'Imagen generada con Hugging Face (gratuito)' :
            (imageUrl.includes('picsum') ?
              'Imagen placeholder (servicios no disponibles)' :
              'Imagen generada exitosamente')
        };
      } else {
        // Generar en memoria, NO guardar en disco
        const fileMetadata = new FileMetadata(
          finalFileName,
          'jpg',
          fileId,
          null
        );

        return {
          success: true,
          buffer: imageBuffer,  // Devolver buffer en lugar de filePath
          filePath: null,  // No hay archivo en disco
          previewPath: null,
          previewDataUrl: blurDataUrl,
          filename: fileMetadata.displayName,
          displayName: fileMetadata.displayName,
          metadata: fileMetadata.toJSON(),
          size: fileSize,
          width: result.images[0].width,
          height: result.images[0].height,
          prompt: prompt,
          message: imageUrl.startsWith('data:image/') ?
            'Imagen generada con Hugging Face (gratuito)' :
            (imageUrl.includes('picsum') ?
              'Imagen placeholder (servicios no disponibles)' :
              'Imagen generada exitosamente')
        };
      }

    } catch (error) {
      console.error('Error generando imagen:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Limpiar archivos antiguos (opcional)
  cleanOldImages(maxAgeHours = 24) {
    try {
      const now = Date.now();
      const maxAge = maxAgeHours * 60 * 60 * 1000;

      const files = fs.readdirSync(this.exportsDir);
      let deleted = 0;

      files.forEach(file => {
        const filePath = path.join(this.exportsDir, file);
        const stats = fs.statSync(filePath);

        if (now - stats.mtime.getTime() > maxAge && file.match(/\.(jpg|png|jpeg)$/i)) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      });

      if (deleted > 0) {
        console.log(`Limpieza automática: ${deleted} imágenes eliminadas`);
      }
    } catch (error) {
      console.error('Error en limpieza de imágenes:', error);
    }
  }
}

const imageService = new ImageService();
export default imageService;
