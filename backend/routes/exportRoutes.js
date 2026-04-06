import express from 'express';
import exportService from '../services/exportService.js';
import auth from '../middleware/auth.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

const router = express.Router();

// Función helper para obtener la ruta de la biblioteca
function getLibraryPath() {
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

// Endpoint principal para exportar contenido
router.post('/export', auth, async (req, res) => {
  try {
    const { format, content, filename } = req.body;

    // Validaciones
    if (!format) {
      return res.status(400).json({
        success: false,
        error: 'El campo "format" es requerido'
      });
    }

    if (!content) {
      return res.status(400).json({
        success: false,
        error: 'El campo "content" es requerido'
      });
    }

    if (!filename) {
      return res.status(400).json({
        success: false,
        error: 'El campo "filename" es requerido'
      });
    }

    // Validar formato
    const validFormats = ['pdf', 'docx', 'txt', 'csv', 'xlsx'];
    if (!validFormats.includes(format.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Formato no válido. Formatos soportados: ${validFormats.join(', ')}`
      });
    }


    // Realizar la exportación
    const result = await exportService.export(format, content, filename);

    if (result.success) {

      // Configurar headers correctos para descarga
      let contentType = 'application/octet-stream';

      switch(format.toLowerCase()) {
        case 'pdf':
          contentType = 'application/pdf';
          break;
        case 'docx':
          contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          break;
        case 'xlsx':
          contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          break;
        case 'csv':
          contentType = 'text/csv';
          break;
        case 'txt':
          contentType = 'text/plain';
          break;
      }

      const downloadFilename = `${filename}.${format.toLowerCase()}`;

      // Configurar headers explícitamente
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
      res.setHeader('Cache-Control', 'no-cache');

      // Enviar archivo con path absoluto
      res.sendFile(path.resolve(result.filePath), (err) => {
        if (err) {
          console.error('Error al enviar archivo:', err);
          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              error: 'Error al enviar el archivo'
            });
          }
        } else {
                            }
      });
    } else {
      console.error('Error en exportación:', result.error);
      res.status(500).json({
        success: false,
        error: result.error
      });
    }

  } catch (error) {
    console.error('Error en endpoint de exportación:', error);
    res.status(500).json({
      success: false,
      error: error.error || 'Error interno del servidor'
    });
  }
});

// Endpoint para exportar como JSON (información del archivo sin descarga)
router.post('/export-info', auth, async (req, res) => {
  try {
    const { format, content, filename } = req.body;

    // Validaciones básicas
    if (!format || !content || !filename) {
      return res.status(400).json({
        success: false,
        error: 'Los campos format, content y filename son requeridos'
      });
    }

    const result = await exportService.export(format, content, filename);

    if (result.success) {
      // Obtener información del archivo
      const stats = fs.statSync(result.filePath);

      res.json({
        success: true,
        message: result.message,
        fileInfo: {
          filename: `${filename}.${format.toLowerCase()}`,
          format: format.toUpperCase(),
          size: stats.size,
          created: stats.birthtime,
          path: result.filePath
        }
      });
    } else {
      res.status(500).json(result);
    }

  } catch (error) {
    console.error('Error en endpoint de información de exportación:', error);
    res.status(500).json({
      success: false,
      error: error.error || 'Error interno del servidor'
    });
  }
});

// Endpoint para listar archivos exportados
router.get('/exports', auth, async (req, res) => {
  try {
    const exportsDir = getLibraryPath();

    if (!fs.existsSync(exportsDir)) {
      return res.json({
        success: true,
        files: [],
        message: 'No hay archivos exportados'
      });
    }

    const files = fs.readdirSync(exportsDir);
    const fileList = files.map(file => {
      const filePath = path.join(exportsDir, file);
      const stats = fs.statSync(filePath);
      const ext = path.extname(file).toLowerCase();

      return {
        filename: file,
        format: ext.substring(1).toUpperCase(),
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime
      };
    });

    res.json({
      success: true,
      files: fileList.sort((a, b) => new Date(b.created) - new Date(a.created)),
      count: fileList.length
    });

  } catch (error) {
    console.error('Error al listar archivos exportados:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener la lista de archivos'
    });
  }
});

// Endpoint para descargar un archivo específico
router.get('/download/:filename', auth, async (req, res) => {
  try {
    const { filename } = req.params;
    const ext = path.extname(filename).toLowerCase();

  const fileId = req.query.fileId;

  const exportsDir = getLibraryPath();
  const filePath = path.join(exportsDir, filename);

    // Verificar que el archivo existe en disco (auto-save activado)
    if (!fs.existsSync(filePath)) {

      // Buscar en MongoDB
      try {
        const Message = (await import('../models/message.js')).default;

        // BUSCAR POR fileId (único) en lugar de solo nombre
        let query = {
          'generatedFile.fileBuffer': { $exists: true }
        };

        // Si hay fileId, buscar por él (más preciso)
        if (fileId) {
          query['generatedFile.fileId'] = fileId;
        } else {
          // Fallback: buscar por nombre (menos preciso, puede devolver el archivo incorrecto)
          query['generatedFile.nombre'] = filename;
        }

        // Buscar el mensaje más reciente con este archivo
        const message = await Message.findOne(query).sort({ createdAt: -1 }).lean();

        if (!message || !message.generatedFile || !message.generatedFile.fileBuffer) {
          return res.status(404).json({
            success: false,
            error: 'Archivo no encontrado o expirado'
          });
        }

        // Configurar content type
        let contentType = 'application/octet-stream';
        switch(ext) {
          case '.pdf':
            contentType = 'application/pdf';
            break;
          case '.docx':
            contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            break;
          case '.xlsx':
            contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            break;
          case '.csv':
            contentType = 'text/csv';
            break;
          case '.txt':
            contentType = 'text/plain';
            break;
          case '.jpg':
          case '.jpeg':
            contentType = 'image/jpeg';
            break;
          case '.png':
            contentType = 'image/png';
            break;
        }

        // Enviar el archivo desde MongoDB
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Access-Control-Allow-Origin', '*');

        return res.send(message.generatedFile.fileBuffer.buffer);

      } catch (mongoError) {
        console.error('Error al buscar en MongoDB:', mongoError);
        return res.status(404).json({
          success: false,
          error: 'Archivo no encontrado'
        });
      }
    }

    // Obtener información del archivo
    const stats = fs.statSync(filePath);

    // Verificar que el archivo existe
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: 'Archivo no encontrado'
      });
    }
    // Verificar que el archivo está dentro del directorio de exports (seguridad)
    const resolvedPath = path.resolve(filePath);
    const resolvedExportsDir = path.resolve(exportsDir);

    if (!resolvedPath.startsWith(resolvedExportsDir)) {
      return res.status(403).json({
        success: false,
        error: 'Acceso denegado'
      });
    }

    // Configurar headers correctos para PDF
    let contentType = 'application/octet-stream';

    switch(ext) {
      case '.pdf':
        contentType = 'application/pdf';
        break;
      case '.docx':
        contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        break;
      case '.xlsx':
        contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        break;
      case '.csv':
        contentType = 'text/csv';
        break;
      case '.txt':
        contentType = 'text/plain';
        break;
    }

    // Configurar headers explícitamente + CORS + anti-cache agresivo
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('ETag', `"${stats.mtime.getTime()}-${stats.size}"`); // ETag único basado en tiempo de modificación
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    // Enviar archivo
    res.sendFile(path.resolve(filePath));

  } catch (error) {
    console.error('Error al descargar archivo:', error);
    res.status(500).json({
      success: false,
      error: 'Error al descargar el archivo'
    });
  }
});

// Endpoint para eliminar un archivo específico
router.delete('/delete/:filename', auth, async (req, res) => {
  try {
    const { filename } = req.params;
    const exportsDir = getLibraryPath();
    const filePath = path.join(exportsDir, filename);

    // Verificar que el archivo existe
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: 'Archivo no encontrado'
      });
    }

    // Verificar que el archivo está dentro del directorio de exports (seguridad)
    const resolvedPath = path.resolve(filePath);
    const resolvedExportsDir = path.resolve(exportsDir);

    if (!resolvedPath.startsWith(resolvedExportsDir)) {
      return res.status(403).json({
        success: false,
        error: 'Acceso denegado'
      });
    }

    fs.unlinkSync(filePath);

    res.json({
      success: true,
      message: `Archivo ${filename} eliminado correctamente`
    });

  } catch (error) {
    console.error('Error al eliminar archivo:', error);
    res.status(500).json({
      success: false,
      error: 'Error al eliminar el archivo'
    });
  }
});

// Endpoint para limpiar archivos antiguos
router.post('/cleanup', auth, async (req, res) => {
  try {
    const { maxAgeHours = 24 } = req.body;

    exportService.cleanOldFiles(maxAgeHours);

    res.json({
      success: true,
      message: `Limpieza completada. Archivos con más de ${maxAgeHours} horas eliminados.`
    });

  } catch (error) {
    console.error('Error al limpiar archivos:', error);
    res.status(500).json({
      success: false,
      error: 'Error al limpiar archivos antiguos'
    });
  }
});

// Endpoint para obtener formatos soportados
router.get('/formats', (req, res) => {
  res.json({
    success: true,
    formats: [
      {
        id: 'pdf',
        name: 'PDF',
        description: 'Portable Document Format',
        extension: '.pdf',
        mimeType: 'application/pdf'
      },
      {
        id: 'docx',
        name: 'Word Document',
        description: 'Microsoft Word Document',
        extension: '.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      },
      {
        id: 'txt',
        name: 'Text File',
        description: 'Plain Text File',
        extension: '.txt',
        mimeType: 'text/plain'
      },
      {
        id: 'csv',
        name: 'CSV',
        description: 'Comma Separated Values',
        extension: '.csv',
        mimeType: 'text/csv'
      },
      {
        id: 'xlsx',
        name: 'Excel Spreadsheet',
        description: 'Microsoft Excel Spreadsheet',
        extension: '.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }
    ]
  });
});

export default router;
