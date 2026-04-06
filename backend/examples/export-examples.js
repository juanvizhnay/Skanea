// Ejemplos de uso del servicio de exportación
// Para probar estos endpoints, puedes usar herramientas como Postman, Thunder Client o curl

const examples = {
  // 1. Exportar como PDF
  pdf: {
    method: "POST",
    url: "http://localhost:10000/api/export",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_JWT_TOKEN"
    },
    body: {
      "format": "pdf",
      "content": "Este es un documento PDF de prueba.\n\nEste texto será convertido a PDF con formato profesional incluyendo fecha y título.",
      "filename": "documento_prueba"
    }
  },

  // 2. Exportar como DOCX (Word)
  docx: {
    method: "POST",
    url: "http://localhost:10000/api/export",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_JWT_TOKEN"
    },
    body: {
      "format": "docx",
      "content": "Este es un documento de Word de prueba.\n\nPuedes usar este formato para crear documentos más elaborados.",
      "filename": "documento_word"
    }
  },

  // 3. Exportar como TXT
  txt: {
    method: "POST",
    url: "http://localhost:10000/api/export",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_JWT_TOKEN"
    },
    body: {
      "format": "txt",
      "content": "Este es un archivo de texto plano.\nPerfecto para contenido simple.",
      "filename": "archivo_texto"
    }
  },

  // 4. Exportar como CSV
  csv: {
    method: "POST",
    url: "http://localhost:10000/api/export",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_JWT_TOKEN"
    },
    body: {
      "format": "csv",
      "content": "Producto A\nProducto B\nProducto C\nProducto D",
      "filename": "lista_productos"
    }
  },

  // 5. Exportar como CSV con datos estructurados
  csvWithData: {
    method: "POST",
    url: "http://localhost:10000/api/export",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_JWT_TOKEN"
    },
    body: {
      "format": "csv",
      "content": [
        { "nombre": "Juan", "edad": 25, "ciudad": "Madrid" },
        { "nombre": "María", "edad": 30, "ciudad": "Barcelona" },
        { "nombre": "Carlos", "edad": 35, "ciudad": "Valencia" }
      ],
      "filename": "usuarios"
    }
  },

  // 6. Exportar como XLSX (Excel)
  xlsx: {
    method: "POST",
    url: "http://localhost:10000/api/export",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_JWT_TOKEN"
    },
    body: {
      "format": "xlsx",
      "content": "Enero: 1000\nFebrero: 1200\nMarzo: 1500\nAbril: 1800",
      "filename": "ventas_2024"
    }
  },

  // 7. Obtener información sin descargar
  exportInfo: {
    method: "POST",
    url: "http://localhost:10000/api/export-info",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer YOUR_JWT_TOKEN"
    },
    body: {
      "format": "pdf",
      "content": "Contenido de prueba",
      "filename": "info_test"
    }
  },

  // 8. Listar archivos exportados
  listExports: {
    method: "GET",
    url: "http://localhost:10000/api/exports",
    headers: {
      "Authorization": "Bearer YOUR_JWT_TOKEN"
    }
  },

  // 9. Descargar archivo específico
  downloadFile: {
    method: "GET",
    url: "http://localhost:10000/api/download/documento_prueba.pdf",
    headers: {
      "Authorization": "Bearer YOUR_JWT_TOKEN"
    }
  },

  // 10. Obtener formatos soportados
  getFormats: {
    method: "GET",
    url: "http://localhost:10000/api/formats"
  }
};

// Ejemplo de uso con fetch (JavaScript)
const ejemploFetch = `
// Ejemplo para usar en el frontend
async function exportarArchivo(formato, contenido, nombreArchivo) {
  try {
    const token = localStorage.getItem('token'); // o donde tengas el JWT
    
    const response = await fetch('http://localhost:10000/api/export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': \`Bearer \${token}\`
      },
      body: JSON.stringify({
        format: formato,
        content: contenido,
        filename: nombreArchivo
      })
    });

    if (response.ok) {
      // El archivo se descarga automáticamente
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`\${nombreArchivo}.\${formato}\`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } else {
      const error = await response.json();
      console.error('Error:', error);
    }
  } catch (error) {
    console.error('Error de red:', error);
  }
}

// Usar la función
exportarArchivo('pdf', 'Mi contenido', 'mi_archivo');
`;

console.log('Ejemplos de exportación cargados');
console.log('Usa los objetos en "examples" para probar los endpoints');
console.log('Código de ejemplo:', ejemploFetch);

export { examples, ejemploFetch };
