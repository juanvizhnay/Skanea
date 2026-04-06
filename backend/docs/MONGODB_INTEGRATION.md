# Integración MongoDB - Skanea

## Descripción General

Esta integración agrega MongoDB a Skanea para gestionar el historial de conversaciones, mensajes y espacios de trabajo de los usuarios. La arquitectura mantiene PostgreSQL para usuarios y autenticación, Redis para sesiones, y MongoDB para el contenido de las conversaciones.

## Estructura de Datos

### 1. Workspace (Espacios de Trabajo)
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

### 2. Conversation (Conversaciones)
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

### 3. Message (Mensajes)
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

## Configuración

### 1. Variables de Entorno
Agregar al archivo `.env`:
```env
# MongoDB
MONGODB_URI=mongodb://localhost:27017/skanea
# O para MongoDB Atlas:
# MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/skanea?retryWrites=true&w=majority
```

### 2. Instalación de Dependencias
```bash
cd backend
npm install mongoose
```

## API Endpoints

### Workspaces

#### Crear Workspace
```http
POST /api/workspaces
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Mi Proyecto",
  "description": "Descripción del proyecto",
  "color": "#3B82F6"
}
```

#### Obtener Workspaces
```http
GET /api/workspaces
Authorization: Bearer <token>
```

#### Obtener Workspace Específico
```http
GET /api/workspaces/:id
Authorization: Bearer <token>
```

#### Actualizar Workspace
```http
PUT /api/workspaces/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Nuevo Nombre",
  "color": "#10B981"
}
```

#### Archivar/Desarchivar Workspace
```http
PATCH /api/workspaces/:id/archive
Authorization: Bearer <token>
```

#### Eliminar Workspace
```http
DELETE /api/workspaces/:id
Authorization: Bearer <token>
```

### Conversaciones

#### Crear Conversación
```http
POST /api/conversations
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Nueva Conversación",
  "workspaceId": "workspace_id",
  "settings": {
    "model": "gpt-3.5-turbo",
    "temperature": 0.7
  },
  "tags": ["proyecto", "desarrollo"]
}
```

#### Obtener Conversaciones
```http
GET /api/conversations?workspaceId=workspace_id&page=1&limit=20
Authorization: Bearer <token>
```

#### Obtener Conversaciones por Fecha
```http
GET /api/conversations/by-date?workspaceId=workspace_id&days=30
Authorization: Bearer <token>
```

#### Buscar Conversaciones
```http
GET /api/conversations/search?q=busqueda&workspaceId=workspace_id
Authorization: Bearer <token>
```

#### Mover Conversación
```http
PATCH /api/conversations/:id/move
Authorization: Bearer <token>
Content-Type: application/json

{
  "workspaceId": "nuevo_workspace_id"
}
```

### Mensajes

#### Crear Mensaje
```http
POST /api/messages
Authorization: Bearer <token>
Content-Type: application/json

{
  "conversationId": "conversation_id",
  "role": "user",
  "content": "Hola, ¿cómo estás?",
  "attachments": [
    {
      "type": "image",
      "url": "https://example.com/image.jpg",
      "filename": "image.jpg",
      "size": 1024,
      "mimeType": "image/jpeg"
    }
  ]
}
```

#### Obtener Mensajes de una Conversación
```http
GET /api/messages/conversation/:conversationId?page=1&limit=50
Authorization: Bearer <token>
```

#### Buscar Mensajes
```http
GET /api/messages/search?q=busqueda&conversationId=conversation_id
Authorization: Bearer <token>
```

#### Marcar Mensaje como Leído
```http
PATCH /api/messages/:id/read
Authorization: Bearer <token>
```

## Índices Recomendados

### Para Performance
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
```

### Para Búsqueda de Texto
```javascript
// Búsqueda en conversaciones
db.conversations.createIndex({ "title": "text", "summary": "text" })

// Búsqueda en mensajes
db.messages.createIndex({ "content": "text" })
```

## Ejemplos de Uso en Frontend

### React Hook para Workspaces
```javascript
import { useState, useEffect } from 'react';

export const useWorkspaces = () => {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchWorkspaces = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('http://localhost:10000/api/workspaces', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) throw new Error('Error fetching workspaces');
      
      const data = await response.json();
      setWorkspaces(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const createWorkspace = async (workspaceData) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('http://localhost:10000/api/workspaces', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(workspaceData)
      });

      if (!response.ok) throw new Error('Error creating workspace');
      
      await fetchWorkspaces();
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  return { workspaces, loading, error, createWorkspace, refetch: fetchWorkspaces };
};
```

### React Hook para Conversaciones
```javascript
export const useConversations = (workspaceId) => {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchConversations = async () => {
    if (!workspaceId) return;
    
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(
        `http://localhost:10000/api/conversations/by-date?workspaceId=${workspaceId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) throw new Error('Error fetching conversations');
      
      const data = await response.json();
      setConversations(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConversations();
  }, [workspaceId]);

  return { conversations, loading, error, refetch: fetchConversations };
};
```

## Consideraciones de Seguridad

### 1. Autenticación
- Todas las rutas requieren token JWT válido
- Verificación de propiedad de recursos (usuario solo puede acceder a sus datos)

### 2. Validación de Datos
- Validación de esquemas con Mongoose
- Sanitización de inputs
- Límites en tamaños de archivos y contenido

### 3. Rate Limiting
- Implementar rate limiting en endpoints críticos
- Límites por usuario y por IP

### 4. Auditoría
- Logging de operaciones críticas
- Tracking de uso de tokens y recursos

## Optimizaciones de Performance

### 1. Paginación
- Implementar paginación en todas las consultas de listas
- Usar cursor-based pagination para grandes datasets

### 2. Caching
- Cachear workspaces y conversaciones frecuentemente accedidas
- Usar Redis para cache de consultas complejas

### 3. Índices
- Crear índices compuestos para consultas frecuentes
- Monitorear uso de índices con `explain()`

### 4. Agregaciones
- Usar agregaciones de MongoDB para estadísticas
- Pre-calcular métricas comunes

## Monitoreo y Mantenimiento

### 1. Métricas a Monitorear
- Tiempo de respuesta de consultas
- Uso de memoria y CPU
- Tamaño de la base de datos
- Número de conexiones activas

### 2. Backup y Recuperación
- Backup automático diario
- Pruebas de recuperación regulares
- Documentación de procedimientos de DR

### 3. Limpieza de Datos
- Implementar TTL para datos temporales
- Archivar conversaciones antiguas
- Limpiar mensajes eliminados periódicamente

## Escalabilidad

### 1. Sharding
- Shard por userId para distribuir carga
- Considerar sharding por fecha para datos históricos

### 2. Replicación
- Configurar replica set para alta disponibilidad
- Leer desde secundarios para consultas de solo lectura

### 3. Microservicios
- Separar servicios de conversación y mensajería
- Implementar colas para procesamiento asíncrono

## Troubleshooting

### Problemas Comunes

1. **Error de Conexión a MongoDB**
   - Verificar MONGODB_URI
   - Comprobar firewall y red
   - Verificar credenciales

2. **Consultas Lentas**
   - Revisar índices
   - Optimizar consultas
   - Considerar agregaciones

3. **Memoria Alta**
   - Revisar consultas sin límites
   - Implementar paginación
   - Optimizar índices

### Logs Útiles
```javascript
// Habilitar logs de Mongoose
mongoose.set('debug', true);

// Logs de consultas lentas
db.setProfilingLevel(1, { slowms: 100 });
``` 