import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import officegen from 'officegen';
import fs from 'fs';
import path from 'path';
import createCsvWriter from 'csv-writer';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'url';
import os from 'os';
import FileMetadata from '../utils/FileMetadata.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ExportService {
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
  // Ejemplo: archivo.xlsx → archivo (1).xlsx → archivo (2).xlsx
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

    console.log(`[UNIQUE-NAME] Archivo "${baseName}.${extension}" ya existe, usando "${uniqueName}.${extension}"`);
    return { name: uniqueName, path: uniquePath };
  }

  // NUEVA FUNCIÓN: Extraer tema principal del historial COMPLETO de conversación
  extractMainTopicFromHistory(conversationHistory) {
    try {
      if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
        return 'documento_skanea';
      }

      // Extraer solo mensajes del usuario
      const userMessages = conversationHistory
        .filter(msg => msg.role === 'user')
        .map(msg => msg.content || '')
        .filter(content => content.trim().length > 0);

      if (userMessages.length === 0) {
        return 'documento_skanea';
      }

      // Combinar todos los mensajes del usuario para análisis
      const allUserText = userMessages.join(' ').toLowerCase();

      // Patrones específicos con pesos (más específicos = mayor peso)
      const topicPatterns = [
        // Historia - peso alto
        { pattern: /revoluci[óo]n\s+industrial/gi, name: 'revolucion_industrial', weight: 10 },
        { pattern: /guerra\s+fr[íi]a/gi, name: 'guerra_fria', weight: 10 },
        { pattern: /segunda\s+guerra\s+mundial/gi, name: 'segunda_guerra_mundial', weight: 10 },
        { pattern: /primera\s+guerra\s+mundial/gi, name: 'primera_guerra_mundial', weight: 10 },
        { pattern: /independencia/gi, name: 'independencia', weight: 8 },
        { pattern: /conquista/gi, name: 'conquista', weight: 8 },
        { pattern: /renacimiento/gi, name: 'renacimiento', weight: 8 },

        // Educación - peso medio-alto
        { pattern: /notas?\s+(?:de\s+)?(?:mis\s+)?estudiantes?/gi, name: 'notas_estudiantes', weight: 9 },
        { pattern: /estudiantes?\s+(?:con\s+)?notas?/gi, name: 'notas_estudiantes', weight: 9 },
        { pattern: /calificaciones?\s+estudiantes?/gi, name: 'calificaciones_estudiantes', weight: 9 },
        { pattern: /lista\s+estudiantes?/gi, name: 'lista_estudiantes', weight: 8 },
        { pattern: /datos\s+estudiantes?/gi, name: 'datos_estudiantes', weight: 8 },

        // Ciencias - peso alto
        { pattern: /qu[íi]mica/gi, name: 'quimica', weight: 9 },
        { pattern: /f[íi]sica/gi, name: 'fisica', weight: 9 },
        { pattern: /biolog[íi]a/gi, name: 'biologia', weight: 9 },
        { pattern: /matem[áa]ticas/gi, name: 'matematicas', weight: 9 },

        // Negocios - peso medio
        { pattern: /inventario/gi, name: 'inventario', weight: 7 },
        { pattern: /ventas/gi, name: 'ventas', weight: 7 },
        { pattern: /compras/gi, name: 'compras', weight: 7 },
        { pattern: /facturaci[óo]n/gi, name: 'facturacion', weight: 7 },
        { pattern: /contabilidad/gi, name: 'contabilidad', weight: 7 },
        { pattern: /presupuesto/gi, name: 'presupuesto', weight: 7 },

        // Tecnología - peso medio-alto
        { pattern: /programaci[óo]n/gi, name: 'programacion', weight: 8 },
        { pattern: /inteligencia\s+artificial/gi, name: 'inteligencia_artificial', weight: 9 },
        { pattern: /machine\s+learning/gi, name: 'machine_learning', weight: 9 },

        // Temas genéricos - peso bajo
        { pattern: /\breporte\b/gi, name: 'reporte', weight: 5 },
        { pattern: /\binforme\b/gi, name: 'informe', weight: 5 },
        { pattern: /an[áa]lisis/gi, name: 'analisis', weight: 6 },
      ];

      // Buscar y puntuar todos los temas
      const topicScores = {};

      for (const { pattern, name, weight } of topicPatterns) {
        const matches = allUserText.match(pattern);
        if (matches && matches.length > 0) {
          const score = matches.length * weight;
          topicScores[name] = (topicScores[name] || 0) + score;
        }
      }

      // Encontrar el tema con mayor puntuación
      let bestTopic = 'documento_skanea';
      let bestScore = 0;

      for (const [topic, score] of Object.entries(topicScores)) {
        if (score > bestScore) {
          bestScore = score;
          bestTopic = topic;
        }
      }

      // Darle más peso a temas que aparecen en mensajes tempranos (más importantes)
      if (bestScore > 0) {
        for (let i = 0; i < Math.min(userMessages.length, 5); i++) {
          const earlyMessage = userMessages[i].toLowerCase();
          for (const { pattern, name, weight } of topicPatterns) {
            const matches = earlyMessage.match(pattern);
            if (matches && matches.length > 0 && name === bestTopic) {
              bestScore += weight * 0.5; // Bonus por aparecer temprano
              break;
            }
          }
        }
      }


      return bestTopic;

    } catch (error) {
      console.error('Error analizando historial:', error);
      return 'documento_skanea';
    }
  }

  // Detectar si la solicitud actual es una CONTINUACIÓN (mismo contenido, otro formato)
  isContinuationRequest(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.toLowerCase();
    const patterns = [
      /\b(mismo|misma|mismas|mismos|igual)\b/i,
      /\b(pasalo|pásalo|dame|dámelo|entregalo|entrégalo|conviertelo|convierte|transformalo|transfórmalo)\b/i,
      /\b(ahora\s+en|en\s+(pdf|docx|word|pptx|powerpoint|txt|csv|excel|xlsx)|a\s+(pdf|docx|pptx|txt|csv|xlsx))\b/i,
      /\b(esas?\s+misma?s\s+notas?)\b/i,
      /\b(el\s+mismo\s+pero|lo\s+mismo\s+pero)\b/i
    ];
    return patterns.some(p => p.test(t));
  }

  // Encontrar el ÍNDICE del último mensaje que introduce un NUEVO TEMA
  findNewTopicPivotIndex(userMessages) {
    if (!Array.isArray(userMessages) || userMessages.length === 0) return 0;
    for (let i = userMessages.length - 1; i >= 0; i--) {
      const m = (userMessages[i] || '').toLowerCase();
      const newTopicTriggers = [
        /(ahora|quiero|necesito|haz|hazme|genera|crear|crea|prepara|puedes).*\b(sobre|de|del)\b/i,
        /(por\s+otro\s+lado|cambiemos\s+de\s+tema|otro\s+tema|nuevo\s+tema)/i,
        /(presentacion|presentación|documento|reporte|informe)\s+(nuevo|diferente)/i
      ];
      if (newTopicTriggers.some(p => p.test(m))) {
        return i; // considerar desde aquí hacia adelante
      }
    }
    return 0;
  }

  // Extraer tema usando recencia y pivotes de tema
  extractTopicFromHistoryWithRecency(userRequest, conversationHistory) {
    try {
      if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
        // si no hay historial, intentar con la solicitud actual
        const fromRequest = this.generateDescriptiveFilename(userRequest || '');
        return fromRequest || 'documento_skanea';
      }

      const userMessages = conversationHistory
        .filter(msg => msg.role === 'user')
        .map(msg => msg.content || '')
        .filter(text => text && text.trim().length > 0);

      if (userMessages.length === 0) {
        return this.generateDescriptiveFilename(userRequest || '') || 'documento_skanea';
      }

      const isContinuation = this.isContinuationRequest(userRequest || '');

      // Si NO es continuación y la solicitud actual trae un tema específico, úsalo directo
      if (!isContinuation) {
        const candidateFromRequest = this.generateDescriptiveFilename(userRequest || '');
        const generic = ['reporte', 'informe', 'analisis', 'documento_skanea'];
        if (candidateFromRequest && !generic.includes(candidateFromRequest)) {
          return candidateFromRequest;
        }
      }

      // Elegir ventana desde el último pivote de nuevo tema
      const pivot = this.findNewTopicPivotIndex(userMessages);
      const windowMessages = userMessages.slice(pivot);

      // Recencia: multiplicador lineal 1.0 → 3.0 (más reciente pesa más)
      const n = windowMessages.length;
      const scoreByTopic = {};

      for (let idx = 0; idx < n; idx++) {
        const msg = windowMessages[idx].toLowerCase();
        const recencyMultiplier = 1 + ((idx + 1) / n) * 2; // 1..3

        // Reutilizar el mapa de patrones de extractMainTopicFromHistory
        const topic = this.generateDescriptiveFilename(msg);
        if (topic && topic !== 'documento_skanea') {
          scoreByTopic[topic] = (scoreByTopic[topic] || 0) + recencyMultiplier * 10;
        }
      }

      // Si es continuación explícita, forzar al último tema específico reconocido
      if (isContinuation) {
        for (let i = n - 1; i >= 0; i--) {
          const candidate = this.generateDescriptiveFilename(windowMessages[i]);
          if (candidate && candidate !== 'documento_skanea' && !['reporte','informe','analisis'].includes(candidate)) {
            return candidate;
          }
        }
      }

      // Elegir mejor tema por puntuación
      let bestTopic = null;
      let bestScore = 0;
      for (const [topic, score] of Object.entries(scoreByTopic)) {
        if (score > bestScore) {
          bestScore = score;
          bestTopic = topic;
        }
      }

      return bestTopic || this.extractMainTopicFromHistory(conversationHistory) || 'documento_skanea';
    } catch (err) {
      console.error('Error en extracción con recencia:', err);
      return 'documento_skanea';
    }
  }

  // Generar nombre de archivo descriptivo basado en la SOLICITUD del usuario (no el contenido generado)
  generateDescriptiveFilename(userRequest) {
    try {
      if (!userRequest || typeof userRequest !== 'string') {
        return 'documento_skanea';
      }

      const request = userRequest.trim().toLowerCase();

      let filename = '';

      // Limpiar la solicitud de palabras de comando
      let cleanRequest = request
        // Verbos comunes con enclíticos (me/lo/la/los/las/nos)
        .replace(/\b(genera(?:me|nos|lo|la|los|las)?|haz(?:me|nos|lo|la|los|las)?|crea(?:me|nos|lo|la|los|las)?|convierte(?:me|nos|lo|la|los|las)?|transforma(?:me|nos|lo|la|los|las)?|pasa(?:me|nos|lo|la|los|las)?|entrega(?:me|nos|lo|la|los|las)?|manda(?:me|nos|lo|la|los|las)?|envia(?:me|nos|lo|la|los|las)?|envía(?:me|nos|lo|la|los|las)?)\b/gi, '')
        .replace(/\b(genera|generar|generame|generarme|crea|crear|crearme|haz|hacer|dar|dame|darme|darmelo|dármelo|dámelo|dalo|darlo|darselo|dárselo|puedes\s+dar|puedes|podrías|me\s+puedes|pásalo|pasalo|pásame|pasame|pásamelo|pasamelo|envíame|enviame|mándame|mandame|entrégame|entregame|ahora|también|después)\b/gi, '')
        // Frases de carpeta en Drive (no deben contaminar el tema)
        .replace(/en\s+(mi\s+)?carpeta\s+["'“”‘’][^"'“”‘’]+["'“”‘’]/gi, '')
        .replace(/en\s+(mi\s+)?carpeta\s+[a-z0-9áéíóúñ\s\.\-_]+/gi, '')
        // verbos de subir a drive
        .replace(/\b(subir|sube|subelo|súbelo|subirlo|subirla|subirlos|subirlas|súbela|súbelos|súbelas)\b/gi, '')
        // conectores y posesivos comunes
        .replace(/\b(un|una|el|la|los|las|mi|mis|tu|tus|su|sus|documento|archivo|presentaci[oó]n|en|sobre|de|del|con|para|a|al)\b/gi, '')
        // plataformas destino
        .replace(/\b(google\s+)?drive\b/gi, '')
        .replace(/\b(carpeta|carpetas)\b/gi, '')
        .replace(/\b(google)\b/gi, '')
        .replace(/\b(pdf|docx|word|pptx|powerpoint|txt|texto|csv|excel|excell|xlsx)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();


      // Patrones específicos comunes
      const specificPatterns = [
        // Historia
        { pattern: /revoluci[óo]n\s+industrial/i, name: 'revolucion_industrial' },
        { pattern: /guerra\s+fr[íi]a/i, name: 'guerra_fria' },
        { pattern: /segunda\s+guerra\s+mundial/i, name: 'segunda_guerra_mundial' },
        { pattern: /primera\s+guerra\s+mundial/i, name: 'primera_guerra_mundial' },
        { pattern: /independencia/i, name: 'independencia' },
        { pattern: /conquista/i, name: 'conquista' },
        { pattern: /renacimiento/i, name: 'renacimiento' },

        // Educación
        { pattern: /notas?\s+(?:de\s+)?(?:mis\s+)?estudiantes?/i, name: 'notas_estudiantes' },
        { pattern: /estudiantes?\s+(?:con\s+)?notas?/i, name: 'notas_estudiantes' },
        { pattern: /calificaciones?\s+estudiantes?/i, name: 'calificaciones_estudiantes' },
        { pattern: /lista\s+estudiantes?/i, name: 'lista_estudiantes' },
        { pattern: /datos\s+estudiantes?/i, name: 'datos_estudiantes' },
        { pattern: /curriculum/i, name: 'curriculum' },
        { pattern: /horario/i, name: 'horario' },

        // Negocios
        { pattern: /inventario/i, name: 'inventario' },
        { pattern: /reporte/i, name: 'reporte' },
        { pattern: /informe/i, name: 'informe' },
        { pattern: /an[áa]lisis/i, name: 'analisis' },
        { pattern: /presupuesto/i, name: 'presupuesto' },
        { pattern: /ventas/i, name: 'ventas' },
        { pattern: /compras/i, name: 'compras' },
        { pattern: /facturaci[óo]n/i, name: 'facturacion' },
        { pattern: /contabilidad/i, name: 'contabilidad' },
        { pattern: /clientes/i, name: 'clientes' },
        { pattern: /proveedores/i, name: 'proveedores' },

        // Ciencias
        { pattern: /qu[íi]mica/i, name: 'quimica' },
        { pattern: /f[íi]sica/i, name: 'fisica' },
        { pattern: /biolog[íi]a/i, name: 'biologia' },
        { pattern: /matem[áa]ticas/i, name: 'matematicas' },

        // Deportes/Entretenimiento
        { pattern: /f[úu]tbol/i, name: 'futbol' },
        { pattern: /baloncesto/i, name: 'baloncesto' },
        { pattern: /m[úu]sica/i, name: 'musica' },
        { pattern: /pel[íi]culas?/i, name: 'peliculas' },

        // Tecnología
        { pattern: /programaci[óo]n/i, name: 'programacion' },
        { pattern: /software/i, name: 'software' },
        { pattern: /hardware/i, name: 'hardware' },
        { pattern: /inteligencia\s+artificial/i, name: 'inteligencia_artificial' },
        { pattern: /machine\s+learning/i, name: 'machine_learning' },
      ];

      // Buscar patrones específicos primero
      for (const { pattern, name } of specificPatterns) {
        if (pattern.test(cleanRequest)) {
          filename = name;
          break;
        }
      }

      // Si no encuentra patrón específico, extraer palabras clave
      if (!filename) {
        const keywords = cleanRequest
          .split(/\s+/)
          .filter(word => {
            // Filtros estrictos
            if (word.length < 3) return false;
            if (/^\d+$/.test(word)) return false; // No números puros
            if (/^[\d\.,]+$/.test(word)) return false; // No solo números y puntos

            // Lista de stop words
            const stopWords = [
              'que', 'son', 'mas', 'donde', 'todos', 'tienen', 'pero', 'mismo', 'mismas',
              'esas', 'estos', 'esta', 'este', 'como', 'muy', 'bien', 'solo', 'cada',
              'otro', 'otra', 'otros', 'otras', 'todo', 'toda', 'cuando', 'desde',
              'hasta', 'antes', 'después', 'claro', 'perfecto', 'excelente', 'igual',
              'mismos', 'misma', 'mismas', 'lo', 'la', 'el', 'los', 'las', 'dar', 'dame',
              'darme', 'puedes', 'podes', 'podrias', 'podrías', 'me', 'esas', 'esas mismas',
              'carpeta', 'carpetas', 'drive',
              // Palabras de comando que deben ser filtradas
              'generame', 'generarme', 'generar', 'crear', 'crearme', 'creando', 'haciendo',
              'escribiendo', 'redactando', 'redactado', 'redactame', 'haz', 'escribe', 'redacta',
              'genera', 'creado', 'creada', 'creados', 'creadas', 'hazme', 'hacerme', 'escribeme',
              'escribir', 'escribirme', 'hacer', 'archivo', 'documento', 'texto', 'sobre', 'acerca',
              'del', 'de', 'un', 'una', 'por', 'para', 'con', 'en', 'te', 'se', 'le', 'nos', 'les',
              'quiero', 'necesito', 'podes', 'los', 'las', 'desde', 'hasta', 'entre', 'y', 'o', 'pero',
              // ordinales y referencias vagas
              'primer', 'primero', 'primera', 'segundo', 'tercero', 'cuarto', 'quinto',
              'sexto', 'séptimo', 'septimo', 'octavo', 'noveno', 'décimo', 'decimo',
              'mismos', 'mis', 'misas', 'mias', 'míos', 'mías'
            ];

            return !stopWords.includes(word);
          })
          .slice(0, 4); // Máximo 4 palabras clave

        if (keywords.length > 0) {
          filename = keywords.join('_');
        }
      }

      // Validación final
      if (!filename || filename.length < 3) {
        return 'documento_skanea';
      }

      // Normalización final
      filename = filename
        .replace(/[áàäâ]/g, 'a')
        .replace(/[éèëê]/g, 'e')
        .replace(/[íìïî]/g, 'i')
        .replace(/[óòöô]/g, 'o')
        .replace(/[úùüû]/g, 'u')
        .replace(/ñ/g, 'n')
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 40);

      return filename;

    } catch (error) {
      console.error('Error generando nombre:', error);
      return 'documento_skanea';
    }
  }

  async exportToPDF(content, filename, displayName = null) {
    try {
      const filePath = path.join(this.exportsDir, `${filename}.pdf`);

      // Crear documento
      const doc = new PDFDocument({
        margin: 50,
        size: 'A4'
      });

      return new Promise((resolve, reject) => {
        let pendingStepCount = 2;

        const stepFinished = (source) => {
          pendingStepCount--;

          if (pendingStepCount === 0) {
            // Ambos pasos completados - verificar archivo
            try {
              if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);

                // Leer los primeros bytes para verificar que es un PDF válido
                const buffer = fs.readFileSync(filePath);
                const pdfHeader = buffer.slice(0, 4).toString();

                if (pdfHeader === '%PDF') {
                  resolve({
                    success: true,
                    filePath,
                    displayName: displayName || `${filename}.pdf`,
                    message: 'PDF generado exitosamente'
                  });
                } else {
                  reject({
                    success: false,
                    error: `PDF inválido - header: ${pdfHeader}`
                  });
                }
              } else {
                reject({
                  success: false,
                  error: 'Archivo PDF no fue creado'
                });
              }
            } catch (statError) {
              reject({
                success: false,
                error: 'Error al verificar PDF: ' + statError.message
              });
            }
          }
        };

        // Configurar stream de escritura
        const writeStream = fs.createWriteStream(filePath);


        writeStream.on('close', () => {
          stepFinished('writeStream');
        });

        writeStream.on('error', (error) => {
          reject({
            success: false,
            error: 'Error al escribir PDF: ' + error.message
          });
        });

        // Configurar documento
        doc.on('error', (error) => {
          reject({
            success: false,
            error: 'Error al generar PDF: ' + error.message
          });
        });

        doc.on('end', () => {});

        // Conectar documento al stream
        doc.pipe(writeStream);

        // AGREGAR CONTENIDO
        try {
          // Generar título inteligente basado en el nombre del archivo
          let title = '';
          if (filename && filename !== 'documento_skanea') {
            // Convertir nombre de archivo a título legible
            title = filename
              .replace(/_/g, ' ')
              .split(' ')
              .map(word => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ');
          }

          // Agregar título si se encontró uno válido
          if (title) {
            doc.fontSize(16)
               .text(title, {
                 align: 'center',
                 lineGap: 6
               });

            doc.moveDown(2);
          }

          // Agregar el contenido principal
          doc.fontSize(12)
             .text(content, {
               align: 'left',
               lineGap: 4
             });
          // FINALIZAR - esto activa el primer stepFinished
          doc.end();

          // Segundo stepFinished se llama inmediatamente
          stepFinished('manual');
        } catch (contentError) {
          reject({
            success: false,
            error: 'Error al agregar contenido: ' + contentError.message
          });
        }
      });

    } catch (error) {
      throw {
        success: false,
        error: 'Error al crear PDF: ' + error.message
      };
    }
  }

  async exportToDOCX(content, filename, displayName = null) {
    try {
      const children = [];

      // Generar título si tenemos un filename descriptivo
      if (filename && filename !== 'documento_skanea') {
        const title = filename
          .replace(/_/g, ' ')
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');

        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: title,
                bold: true,
                size: 28
              }),
            ],
            alignment: "center",
          }),
          new Paragraph({
            text: "",
          })
        );
      }

      // Agregar el contenido
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: content,
              size: 24
            }),
          ],
        })
      );

      const doc = new Document({
        sections: [{
          properties: {},
          children: children,
        }],
      });

      const filePath = path.join(this.exportsDir, `${filename}.docx`);
      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(filePath, buffer);

      return {
        success: true,
        filePath,
        displayName: displayName || `${filename}.docx`,
        message: 'DOCX generado exitosamente'
      };
    } catch (error) {
      throw {
        success: false,
        error: 'Error al crear DOCX: ' + error.message
      };
    }
  }

  async exportToTXT(content, filename, displayName = null) {
    try {
      const filePath = path.join(this.exportsDir, `${filename}.txt`);

      let finalContent = content;

      // Generar título si tenemos un filename descriptivo
      if (filename && filename !== 'documento_skanea') {
        const title = filename
          .replace(/_/g, ' ')
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');

        finalContent = `${title}\n${'='.repeat(title.length)}\n\n${content}`;
      }

      fs.writeFileSync(filePath, finalContent, 'utf8');

      return {
        success: true,
        filePath,
        displayName: displayName || `${filename}.txt`,
        message: 'TXT generado exitosamente'
      };
    } catch (error) {
      throw {
        success: false,
        error: 'Error al crear TXT: ' + error.message
      };
    }
  }

  async exportToCSV(content, filename, displayName = null) {
    try {
      const filePath = path.join(this.exportsDir, `${filename}.csv`);

      // Procesar el contenido de manera simple y robusta
      const lines = (content || '').split('\n').filter(line => line.trim());

      // Crear CSV simple con dos columnas: Línea y Contenido
      let csvContent = 'Línea,Contenido\n';

      lines.forEach((line, index) => {
        // Escapar comillas y saltos de línea en el contenido
        const escapedContent = line.replace(/"/g, '""').trim();
        csvContent += `${index + 1},"${escapedContent}"\n`;
      });

      // Escribir el archivo CSV con BOM para Excel (UTF-8)
      const BOM = '\uFEFF';
      fs.writeFileSync(filePath, BOM + csvContent, 'utf8');


      return {
        success: true,
        filePath,
        displayName: displayName || `${filename}.csv`,
        message: 'CSV generado exitosamente'
      };
    } catch (error) {
      throw {
        success: false,
        error: 'Error al crear CSV: ' + error.message
      };
    }
  }

  async exportToXLSX(data, filename, displayName = null) {
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Datos Exportados');

      // Si data es un string, convertirlo a array de objetos
      let excelData = [];

      if (typeof data === 'string') {
        const lines = data.split('\n').filter(line => line.trim());
        excelData = lines.map((line, index) => ({
          'Índice': index + 1,
          'Contenido': line.trim()
        }));
      } else if (Array.isArray(data)) {
        excelData = data;
      } else {
        throw new Error('Los datos deben ser un string o un array de objetos');
      }

      if (excelData.length > 0) {
        // Agregar encabezados
        const headers = Object.keys(excelData[0]);
        worksheet.addRow(headers);

        // Formatear encabezados
        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true };
        headerRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE0E0E0' }
        };

        // Agregar datos
        excelData.forEach(row => {
          worksheet.addRow(Object.values(row));
        });

        // Ajustar ancho de columnas
        headers.forEach((header, index) => {
          const column = worksheet.getColumn(index + 1);
          column.width = Math.max(header.length + 5, 15);
        });
      }

      // Si auto-save está activado: guardar en disco
      // Si está desactivado: devolver buffer en memoria
      const autoSaveFiles = arguments[3] !== undefined ? arguments[3] : true;

      if (autoSaveFiles) {
        const filePath = path.join(this.exportsDir, `${filename}.xlsx`);
        await workbook.xlsx.writeFile(filePath);


        return {
          success: true,
          filePath,
          displayName: displayName || `${filename}.xlsx`,
          message: 'XLSX generado exitosamente'
        };
      } else {
        // Generar en memoria, NO guardar en disco
        const buffer = await workbook.xlsx.writeBuffer();


        return {
          success: true,
          buffer,  // Devolver buffer en lugar de filePath
          filePath: null,  // No hay archivo en disco
          displayName: displayName || `${filename}.xlsx`,
          message: 'XLSX generado exitosamente'
        };
      }
    } catch (error) {
      throw {
        success: false,
        error: 'Error al crear XLSX: ' + error.message
      };
    }
  }

  async exportToPPTX(content, filename, displayName = null) {
    try {
      const filePath = path.join(this.exportsDir, `${filename}.pptx`);

      // Crear presentación
      const pptx = officegen({
        type: 'pptx',
        onend: () => {},
        onerr: (e) => console.error('officegen error:', e)
      });

      // Configurar propiedades del documento
      pptx.setDocTitle(`Presentación - ${filename}`);

      // Dividir contenido en slides
      const slides = this.parseContentToSlides(content, filename);
      if (!Array.isArray(slides) || slides.length === 0) {
        slides.push({ title: filename.replace(/_/g, ' ').toUpperCase(), content: 'Contenido no disponible.' });
      }

      slides.forEach((slideData, index) => {
        const slide = pptx.makeNewSlide();

        // Título del slide
        const safeTitle = (slideData.title || 'Slide').toString();
        slide.addText(safeTitle, {
          // usar porcentajes para asegurar ancho correcto en officegen
          x: '5%', y: '6%', cx: '90%', cy: '12%',
          font_size: 28,
          bold: true,
          color: '000000',
          font_face: 'Arial',
          align: 'center',
          valign: 'top'
        });

        // Contenido del slide
        if (slideData.content) {
          // Asegurar que el texto no sea un bloque extremadamente largo (wrap manual)
          const wrapped = slideData.content
            .split(/\n/) // respetar saltos existentes
            .map(line => line.replace(/\s+/g, ' ').trim())
            .map(line => line.match(/.{1,90}/g) || [''])
            .flat()
            .join('\n');

          slide.addText(wrapped, {
            // Debajo del título (en % para evitar estrechamientos)
            x: '5%', y: '20%', cx: '90%', cy: '70%',
            font_size: 20,
            color: '333333',
            font_face: 'Arial',
            align: 'left',
            valign: 'top'
          });
        } else {
          slide.addText(' ', { x: '5%', y: '20%', cx: '90%', cy: '70%' });
        }

        // Número de slide (excepto el primero)
        if (index > 0) {
          slide.addText(`${index + 1}`, {
            x: 9.4, y: 7.0, cx: 0.5, cy: 0.4,
            font_size: 12,
            color: '999999',
            align: 'right'
          });
        }
      });

      return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(filePath);
        let finalized = false;

        out.on('error', (err) => {
          reject({
            success: false,
            error: 'Error al escribir archivo PPTX: ' + err.message
          });
        });
        out.on('finish', () => {
          try {
            const stat = fs.statSync(filePath);
            if (!stat || stat.size < 10240) { // < 10 KB probablemente truncado
              return reject({ success: false, error: 'PPTX demasiado pequeño (<10KB), probablemente truncado' });
            }
          } catch {}
          // Resolver solo cuando el stream haya finalizado en disco
          resolve({
            success: true,
            filePath,
            displayName: displayName || `${filename}.pptx`,
            message: 'PPTX generado exitosamente'
          });
        });

        pptx.on('error', (err) => {
          reject({
            success: false,
            error: 'Error al generar PPTX: ' + err.message
          });
        });
        pptx.on('finalize', () => { finalized = true; });

        pptx.generate(out);
      });

    } catch (error) {
      throw {
        success: false,
        error: 'Error al crear PPTX: ' + error.message
      };
    }
  }

  parseContentToSlides(content, filename) {
    const slides = [];

    // Slide de título
    slides.push({
      title: filename.replace(/_/g, ' ').toUpperCase(),
      content: `Generado el: ${new Date().toLocaleString('es-ES')}\nPor: Skanea AI`
    });

    if (!content || typeof content !== 'string') {
      slides.push({ title: 'Contenido', content: 'Contenido no disponible.' });
      return slides;
    }

    // Normalizar saltos y bullets
    const normalized = content.replace(/\r\n/g, '\n').trim();

    // 1) Detectar listas con viñetas y dividir en items
    const bulletRe = /^(?:[-*•]\s+|\d+\.[)\s]+)/m;
    const hasBullets = bulletRe.test(normalized);
    let chunks = [];
    if (hasBullets) {
      // Separar por línea, agrupar en items; máximo 6 por slide
      const items = normalized
        .split(/\n+/)
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => l.replace(/^[-*•]\s+/, '').replace(/^(\d+)\.[)\s]+/, '$1. '));
      for (let i = 0; i < items.length; i += 6) {
        const pageItems = items.slice(i, i + 6);
        chunks.push({ title: 'Contenido', content: pageItems.map(it => `• ${it}`).join('\n') });
      }
    } else {
      // 2) Dividir por párrafos dobles; limitar longitud por slide
      const sections = normalized.split(/\n\s*\n/).filter(s => s.trim());
      sections.forEach((section, idx) => {
        // Si una sección es muy larga, dividir por líneas a bloques de ~12
        const lines = section.split(/\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length <= 12) {
          const t = lines[0] && lines[0].length <= 60 ? lines[0] : `Sección ${idx + 1}`;
          const c = lines.length > 1 ? lines.slice(1).join('\n') : lines[0];
          chunks.push({ title: t, content: c });
        } else {
          for (let i = 0; i < lines.length; i += 12) {
            const part = lines.slice(i, i + 12);
            const t = i === 0 && lines[0].length <= 60 ? lines[0] : `Sección ${idx + 1} (${Math.floor(i/12)+1})`;
            const c = i === 0 ? part.slice(1).join('\n') : part.join('\n');
            chunks.push({ title: t, content: c });
          }
        }
      });
    }

    if (chunks.length === 0) {
      chunks.push({ title: 'Contenido', content: normalized });
    }

    // Ensamblar resultado
    chunks.forEach(ch => slides.push(ch));
    return slides;
  }

  async export(format, content, filename, userRequest = null, conversationHistory = null, conversationId = null, autoSaveFiles = true) {
    try {
      // Analizar todo el historial para encontrar el tema principal
      let finalFilename = filename;

      if (!filename || filename === 'documento_skanea') {
        // Analizar con RECENCIA y detección de nuevo tema
        if (conversationHistory && Array.isArray(conversationHistory)) {
          const topicByRecency = this.extractTopicFromHistoryWithRecency(userRequest, conversationHistory);
          if (topicByRecency && topicByRecency !== 'documento_skanea') {
            finalFilename = topicByRecency;
          } else {
            const mainTopic = this.extractMainTopicFromHistory(conversationHistory);
            if (mainTopic && mainTopic !== 'documento_skanea') {
              finalFilename = mainTopic;
            }
          }
        }

        // Si no encontró nada en el historial, usar la solicitud actual
        if (finalFilename === filename && userRequest) {
          const descriptiveFilename = this.generateDescriptiveFilename(userRequest);
          if (descriptiveFilename && descriptiveFilename !== 'documento_skanea') {
            finalFilename = descriptiveFilename;
          }
        }
      }

      // Limpiar el nombre del archivo
      let cleanFilename = finalFilename.replace(/[^a-zA-Z0-9_-]/g, '_');

      // Guardar el nombre base limpio (sin extensión ni ID)
      const baseCleanName = cleanFilename;

      // Generar ID único interno (para tracking, NO para el nombre del archivo)
      const fileId = conversationId ? conversationId.slice(-8) : Date.now().toString().slice(-8);

      // Obtener nombre único si el archivo ya existe (estilo Windows)
      const uniqueFile = this.getUniqueFilename(baseCleanName, format.toLowerCase());
      const finalFileName = uniqueFile.name;

      // Llamar a la función de exportación correspondiente
      // IMPORTANTE: Usar finalFileName que puede tener (1), (2), etc. si ya existía
      let exportResult;
      switch (format.toLowerCase()) {
        case 'pdf':
          exportResult = await this.exportToPDF(content, finalFileName, `${finalFileName}.pdf`, autoSaveFiles);
          break;
        case 'docx':
          exportResult = await this.exportToDOCX(content, finalFileName, `${finalFileName}.docx`, autoSaveFiles);
          break;
        case 'pptx':
          exportResult = await this.exportToPPTX(content, finalFileName, `${finalFileName}.pptx`, autoSaveFiles);
          break;
        case 'txt':
          exportResult = await this.exportToTXT(content, finalFileName, `${finalFileName}.txt`, autoSaveFiles);
          break;
        case 'csv':
          exportResult = await this.exportToCSV(content, finalFileName, `${finalFileName}.csv`, autoSaveFiles);
          break;
        case 'xlsx':
          exportResult = await this.exportToXLSX(content, finalFileName, `${finalFileName}.xlsx`, autoSaveFiles);
          break;
        default:
          throw {
            success: false,
            error: 'Formato no soportado. Formatos válidos: pdf, docx, pptx, txt, csv, xlsx'
          };
      }

      // Crear FileMetadata con toda la información estructurada
      const fileMetadata = new FileMetadata(
        finalFileName,  // Usar el nombre final (puede incluir (1), (2), etc.)
        format.toLowerCase(),
        fileId,  // Solo para tracking interno
        exportResult.filePath
      );

      // Agregar metadata al resultado
      exportResult.metadata = fileMetadata.toJSON();

      return exportResult;
    } catch (error) {
      console.error('Error en exportación:', error);
      throw error;
    }
  }

  // Método para limpiar archivos antiguos (opcional)
  cleanOldFiles(maxAgeHours = 24) {
    try {
      const files = fs.readdirSync(this.exportsDir);
      const now = Date.now();
      const maxAge = maxAgeHours * 60 * 60 * 1000; // Convertir a milisegundos

      files.forEach(file => {
        const filePath = path.join(this.exportsDir, file);
        const stats = fs.statSync(filePath);

        if (now - stats.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
        }
      });
    } catch (error) {
      console.error('Error al limpiar archivos antiguos:', error);
    }
  }
}

export default new ExportService();

