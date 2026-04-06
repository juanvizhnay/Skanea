# Integración MongoDB - Skanea

## 🚀 Resumen

Esta integración agrega MongoDB a Skanea para gestionar el historial completo de conversaciones, mensajes y espacios de trabajo. Mantiene la arquitectura existente (PostgreSQL para usuarios, Redis para sesiones) y agrega MongoDB como tercera base de datos especializada en contenido de conversaciones.

## 📋 Características Implementadas

### ✅ Workspaces (Espacios de Trabajo)
- Crear, editar, archivar y eliminar espacios
- Colores personalizables para cada workspace
- Workspace por defecto automático
- Estadísticas de conversaciones por workspace

### ✅ Conversaciones
- Crear conversaciones dentro de workspaces
- Títulos automáticos basados en el primer mensaje
- Tags para categorización
- Configuración de modelo de IA por conversación
- Agrupación por fechas
- Búsqueda avanzada

### ✅ Mensajes
- Soporte para mensajes de usuario, asistente y sistema
- Archivos adjuntos (imágenes, documentos, audio, video)
- Tool calls y resultados de herramientas
- Cálculo automático de tokens
- Estados de mensaje (enviado, leído, error, etc.)

### ✅ Funcionalidades Avanzadas
- Paginación en todas las consultas
- Búsqueda de texto completo
- Estadísticas detalladas
- Soft delete para recuperación
- Índices optimizados para performance

## 🛠️ Instalación y Configuración

### 1. Instalar Dependencias
```bash
cd backend
npm install mongoose
```

### 2. Configurar Variables de Entorno
Agregar al archivo `.env`:
```env
# MongoDB
MONGODB_URI=mongodb://localhost:27017/skanea
# O para MongoDB Atlas:
# MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/skanea?retryWrites=true&w=majority

# Google Programmable Search (CSE)
GOOGLE_SEARCH_API_KEY=tu_api_key
GOOGLE_SEARCH_CX=tu_cx
```

### 3. Iniciar el Servidor
```bash
cd backend
npm start
```

## 📊 Estructura de la Base de Datos

### Colecciones MongoDB

#### `workspaces`
```javascript
{
  _id: ObjectId,
  name: String,           // Nombre del espacio
  description: String,    // Descripción opcional
  userId: String,         // ID del usuario (PostgreSQL)
  color: String,          // Color del workspace (#HEX)
  isDefault: Boolean,     // Si es el workspace por defecto
  isArchived: Boolean,    // Si está archivado
  createdAt: Date,
  updatedAt: Date
}
```

#### `conversations`
```javascript
{
  _id: ObjectId,
  title: String,          // Título de la conversación
  userId: String,         // ID del usuario (PostgreSQL)
  workspaceId: ObjectId,  // Referencia al workspace
  summary: String,        // Resumen generado automáticamente
  tags: [String],         // Tags para categorizar
  status: String,         // 'active', 'archived', 'deleted'
  settings: {
    model: String,        // Modelo de IA usado
    temperature: Number,  // Temperatura del modelo
    maxTokens: Number     // Máximo de tokens
  },
  metadata: {
    totalMessages: Number,
    lastActivity: Date,
    estimatedTokens: Number
  },
  createdAt: Date,
  updatedAt: Date
}
```

#### `messages`
```javascript
{
  _id: ObjectId,
  conversationId: ObjectId,  // Referencia a la conversación
  role: String,              // 'user', 'assistant', 'system'
  content: String,           // Contenido del mensaje
  attachments: [{
    type: String,            // 'image', 'document', 'audio', 'video'
    url: String,
    filename: String,
    size: Number,
    mimeType: String
  }],
  toolCalls: [{
    id: String,
    type: String,            // 'function', 'code_interpreter', 'retrieval'
    function: {
      name: String,
      arguments: String
    }
  }],
  toolResults: [{
    toolCallId: String,
    content: String,
    isError: Boolean
  }],
  metadata: {
    tokens: Number,
    processingTime: Number,
    model: String,
    temperature: Number
  },
  status: String,            // 'pending', 'sent', 'delivered', 'read', 'error', 'deleted'
  isProcessing: Boolean,
  requiresResponse: Boolean,
  createdAt: Date,
  updatedAt: Date
}
```

## 🔌 API Endpoints

### Workspaces
- `POST /api/workspaces` - Crear workspace
- `GET /api/workspaces` - Obtener workspaces del usuario
- `GET /api/workspaces/:id` - Obtener workspace específico
- `PUT /api/workspaces/:id` - Actualizar workspace
- `PATCH /api/workspaces/:id/archive` - Archivar/desarchivar
- `DELETE /api/workspaces/:id` - Eliminar workspace
- `GET /api/workspaces/:id/stats` - Estadísticas del workspace

### Conversaciones
- `POST /api/conversations` - Crear conversación
- `GET /api/conversations` - Obtener conversaciones
- `GET /api/conversations/by-date` - Conversaciones agrupadas por fecha
- `GET /api/conversations/search` - Buscar conversaciones
- `GET /api/conversations/:id` - Obtener conversación específica
- `PUT /api/conversations/:id` - Actualizar conversación
- `PATCH /api/conversations/:id/move` - Mover a otro workspace
- `DELETE /api/conversations/:id` - Eliminar conversación

### Mensajes
- `POST /api/messages` - Crear mensaje
- `GET /api/messages/conversation/:conversationId` - Obtener mensajes
- `GET /api/messages/search` - Buscar mensajes
- `GET /api/messages/:id` - Obtener mensaje específico
- `PUT /api/messages/:id` - Actualizar mensaje
- `DELETE /api/messages/:id` - Eliminar mensaje
- `PATCH /api/messages/:id/read` - Marcar como leído
- `GET /api/messages/conversation/:conversationId/stats` - Estadísticas

## 🎨 Integración con Frontend

### Componente ChatHistory Actualizado
El componente `ChatHistory.jsx` ha sido completamente actualizado para:

1. **Mostrar Workspaces**: Lista de espacios de trabajo con colores y estadísticas
2. **Navegación Jerárquica**: Workspaces → Conversaciones → Mensajes
3. **Agrupación por Fechas**: Conversaciones organizadas por "Hoy", "Ayer", etc.
4. **Creación Dinámica**: Crear workspaces y conversaciones desde la UI
5. **Estados de Carga**: Loading states y manejo de errores

### Estilos CSS
Se incluye `ChatHistory.css` con:
- Diseño moderno y responsive
- Temas oscuros consistentes con Skanea
- Animaciones y transiciones suaves
- Scrollbars personalizados

## 🔧 Configuración de Índices

### Índices Recomendados para Performance
```javascript
// Workspaces
db.workspaces.createIndex({ "userId": 1, "isArchived": 1 })
db.workspaces.createIndex({ "userId": 1, "createdAt": -1 })

// Conversations
db.conversations.createIndex({ "userId": 1, "workspaceId": 1, "status": 1 })
db.conversations.createIndex({ "userId": 1, "metadata.lastActivity": -1 })
db.conversations.createIndex({ "workspaceId": 1, "createdAt": -1 })
db.conversations.createIndex({ "userId": 1, "tags": 1 })

// Messages
db.messages.createIndex({ "conversationId": 1, "createdAt": 1 })
db.messages.createIndex({ "conversationId": 1, "role": 1 })
db.messages.createIndex({ "metadata.tokens": 1 })
db.messages.createIndex({ "status": 1, "isProcessing": 1 })

// Búsqueda de texto
db.conversations.createIndex({ "title": "text", "summary": "text" })
db.messages.createIndex({ "content": "text" })
```

## 📈 Monitoreo y Performance

### Métricas a Monitorear
- Tiempo de respuesta de consultas
- Uso de memoria y CPU
- Tamaño de la base de datos
- Número de conexiones activas
- Hit rate de índices

### Optimizaciones Implementadas
- Paginación en todas las consultas
- Índices compuestos para consultas frecuentes
- Agregaciones para estadísticas
- Soft delete para recuperación
- Cálculo automático de tokens

## 🔒 Seguridad

### Medidas Implementadas
- Autenticación JWT en todos los endpoints
- Verificación de propiedad de recursos
- Validación de esquemas con Mongoose
- Sanitización de inputs
- Rate limiting (recomendado implementar)

### Consideraciones
- Los usuarios solo pueden acceder a sus propios datos
- Validación de workspaceId en conversaciones
- Validación de conversationId en mensajes
- Soft delete para recuperación de datos

## 🚀 Próximos Pasos

### Funcionalidades Sugeridas
1. **Búsqueda Avanzada**: Filtros por fecha, tags, tipo de contenido
2. **Exportación**: Exportar conversaciones a PDF, Markdown, etc.
3. **Compartir**: Compartir conversaciones entre usuarios
4. **Templates**: Plantillas de conversaciones predefinidas
5. **Analytics**: Dashboard con métricas de uso
6. **Backup**: Sistema automático de backup y recuperación

### Optimizaciones Futuras
1. **Caching**: Implementar Redis para cache de consultas frecuentes
2. **CDN**: Para archivos adjuntos
3. **Compresión**: Comprimir mensajes largos
4. **Sharding**: Para escalabilidad horizontal
5. **Microservicios**: Separar servicios de conversación y mensajería

## 📚 Documentación Adicional

- [Documentación Completa](./docs/MONGODB_INTEGRATION.md)
- [Ejemplos de Uso](./examples/api-usage.js)
- [Modelos de Datos](./models/)
- [Controladores](./controllers/)
- [Rutas](./routes/)

## 🤝 Contribución

Para contribuir a esta integración:

1. Fork el repositorio
2. Crea una rama para tu feature
3. Implementa los cambios
4. Agrega tests
5. Documenta los cambios
6. Crea un Pull Request

## 📞 Soporte

Si tienes problemas o preguntas:

1. Revisa la documentación
2. Busca en los issues existentes
3. Crea un nuevo issue con detalles del problema
4. Incluye logs y ejemplos de reproducción

---

**¡Disfruta usando MongoDB con Skanea! 🎉** 

---

## ⚡ Pruebas rápidas

Ejecuta el backend (puerto 10000 por defecto) y prueba estos comandos.

### Precios cripto (gratis, CoinGecko)

PowerShell:
```powershell
curl "http://localhost:10000/api/price/crypto?asset=bitcoin&vs=usd"
curl "http://localhost:10000/api/price/crypto?asset=ethereum&vs=usd"
```

curl:
```bash
curl "http://localhost:10000/api/price/crypto?asset=bitcoin&vs=usd"
curl "http://localhost:10000/api/price/crypto?asset=ethereum&vs=usd"
```

### Tipo de cambio fiat (gratis, exchangerate.host)

PowerShell:
```powershell
curl "http://localhost:10000/api/price/fiat?base=USD&vs=EUR"
```

curl:
```bash
curl "http://localhost:10000/api/price/fiat?base=USD&vs=EUR"
```

### Noticias (gratis, Google News RSS)

PowerShell:
```powershell
curl "http://localhost:10000/api/news?q=llama%203.2"
```

curl:
```bash
curl "http://localhost:10000/api/news?q=llama%203.2"
```

### Websearch con modo simple (Google CSE)

PowerShell:
```powershell
curl -Method POST -Headers @{"Content-Type"="application/json"; "Authorization"="Bearer <JWT>"; "X-Websearch-Mode"="simple"} -Body '{"query":"Llama 3.2 release","count":5}' "http://localhost:10000/api/websearch" | cat
```

curl:
```bash
curl -X POST -H "Content-Type: application/json" -H "Authorization: Bearer <JWT>" -H "X-Websearch-Mode: simple" \
  -d '{"query":"Llama 3.2 release","count":5}' \
  "http://localhost:10000/api/websearch" | cat
```

### Ejemplos de prompts para /preguntar (intents tiempo real)

- Precio cripto: "precio btc ahora" / "btc/usd" / "eth en usd"
- Tipo de cambio: "tipo de cambio usd/eur" / "cuánto está el dólar en euros"
- Noticias: "últimas noticias de llama 3.2 hoy" / "noticias openai 24h"
- Búsqueda simple: "solo links sobre Llama 3.2"