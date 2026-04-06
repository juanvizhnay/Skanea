// Ejemplos de uso de la API de MongoDB para Skanea
// Este archivo muestra cómo usar los endpoints desde JavaScript/Node.js

const API_BASE = 'http://localhost:10000/api';
const TOKEN = 'your_jwt_token_here';

// Función helper para hacer requests
async function apiRequest(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// ===== EJEMPLOS DE WORKSPACES =====

// 1. Crear un nuevo workspace
async function createWorkspace() {
  try {
    const workspace = await apiRequest('/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Mi Proyecto de Desarrollo',
        description: 'Espacio para conversaciones sobre desarrollo web',
        color: '#3B82F6'
      })
    });
    
    console.log('Workspace creado:', workspace.data);
    return workspace.data._id;
  } catch (error) {
    console.error('Error creando workspace:', error);
  }
}

// 2. Obtener todos los workspaces del usuario
async function getWorkspaces() {
  try {
    const response = await apiRequest('/workspaces');
    console.log('Workspaces:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error obteniendo workspaces:', error);
  }
}

// 3. Actualizar un workspace
async function updateWorkspace(workspaceId) {
  try {
    const response = await apiRequest(`/workspaces/${workspaceId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Proyecto Actualizado',
        color: '#10B981'
      })
    });
    
    console.log('Workspace actualizado:', response.data);
  } catch (error) {
    console.error('Error actualizando workspace:', error);
  }
}

// ===== EJEMPLOS DE CONVERSACIONES =====

// 4. Crear una nueva conversación
async function createConversation(workspaceId) {
  try {
    const conversation = await apiRequest('/conversations', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Conversación sobre React',
        workspaceId: workspaceId,
        settings: {
          model: 'gpt-3.5-turbo',
          temperature: 0.7,
          maxTokens: 1000
        },
        tags: ['react', 'frontend', 'desarrollo']
      })
    });
    
    console.log('Conversación creada:', conversation.data);
    return conversation.data._id;
  } catch (error) {
    console.error('Error creando conversación:', error);
  }
}

// 5. Obtener conversaciones de un workspace
async function getConversations(workspaceId) {
  try {
    const response = await apiRequest(`/conversations?workspaceId=${workspaceId}`);
    console.log('Conversaciones:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error obteniendo conversaciones:', error);
  }
}

// 6. Obtener conversaciones agrupadas por fecha
async function getConversationsByDate(workspaceId) {
  try {
    const response = await apiRequest(`/conversations/by-date?workspaceId=${workspaceId}&days=30`);
    console.log('Conversaciones por fecha:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error obteniendo conversaciones por fecha:', error);
  }
}

// 7. Buscar conversaciones
async function searchConversations(query, workspaceId) {
  try {
    const response = await apiRequest(`/conversations/search?q=${encodeURIComponent(query)}&workspaceId=${workspaceId}`);
    console.log('Resultados de búsqueda:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error buscando conversaciones:', error);
  }
}

// ===== EJEMPLOS DE MENSAJES =====

// 8. Crear un mensaje del usuario
async function createUserMessage(conversationId, content) {
  try {
    const message = await apiRequest('/messages', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: conversationId,
        role: 'user',
        content: content
      })
    });
    
    console.log('Mensaje del usuario creado:', message.data);
    return message.data._id;
  } catch (error) {
    console.error('Error creando mensaje del usuario:', error);
  }
}

// 9. Crear un mensaje del asistente
async function createAssistantMessage(conversationId, content) {
  try {
    const message = await apiRequest('/messages', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: conversationId,
        role: 'assistant',
        content: content,
        metadata: {
          model: 'gpt-3.5-turbo',
          temperature: 0.7,
          processingTime: 1500
        }
      })
    });
    
    console.log('Mensaje del asistente creado:', message.data);
    return message.data._id;
  } catch (error) {
    console.error('Error creando mensaje del asistente:', error);
  }
}

// 10. Obtener mensajes de una conversación
async function getMessages(conversationId) {
  try {
    const response = await apiRequest(`/messages/conversation/${conversationId}?limit=50`);
    console.log('Mensajes:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error obteniendo mensajes:', error);
  }
}

// 11. Buscar mensajes
async function searchMessages(query, conversationId) {
  try {
    const response = await apiRequest(`/messages/search?q=${encodeURIComponent(query)}&conversationId=${conversationId}`);
    console.log('Mensajes encontrados:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error buscando mensajes:', error);
  }
}

// ===== EJEMPLO COMPLETO DE FLUJO =====

async function ejemploCompleto() {
  console.log('=== Iniciando ejemplo completo ===');
  
  // 1. Crear workspace
  const workspaceId = await createWorkspace();
  if (!workspaceId) return;
  
  // 2. Crear conversación
  const conversationId = await createConversation(workspaceId);
  if (!conversationId) return;
  
  // 3. Agregar mensajes
  await createUserMessage(conversationId, 'Hola, ¿puedes ayudarme con React?');
  await createAssistantMessage(conversationId, '¡Hola! Por supuesto, estoy aquí para ayudarte con React. ¿Qué específicamente te gustaría saber?');
  await createUserMessage(conversationId, '¿Cómo puedo crear un componente funcional?');
  await createAssistantMessage(conversationId, 'Los componentes funcionales en React son funciones de JavaScript que retornan JSX. Aquí tienes un ejemplo:\n\n```jsx\nfunction MiComponente() {\n  return <div>Hola Mundo</div>;\n}\n```');
  
  // 4. Obtener conversaciones del workspace
  await getConversations(workspaceId);
  
  // 5. Obtener mensajes de la conversación
  await getMessages(conversationId);
  
  // 6. Buscar conversaciones
  await searchConversations('React', workspaceId);
  
  // 7. Buscar mensajes
  await searchMessages('componente', conversationId);
  
  console.log('=== Ejemplo completo terminado ===');
}

// ===== EJEMPLOS DE ESTADÍSTICAS =====

// 12. Obtener estadísticas de un workspace
async function getWorkspaceStats(workspaceId) {
  try {
    const response = await apiRequest(`/workspaces/${workspaceId}/stats`);
    console.log('Estadísticas del workspace:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error obteniendo estadísticas del workspace:', error);
  }
}

// 13. Obtener estadísticas de mensajes de una conversación
async function getMessageStats(conversationId) {
  try {
    const response = await apiRequest(`/messages/conversation/${conversationId}/stats`);
    console.log('Estadísticas de mensajes:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error obteniendo estadísticas de mensajes:', error);
  }
}

// ===== EJEMPLOS DE OPERACIONES AVANZADAS =====

// 14. Mover conversación a otro workspace
async function moveConversation(conversationId, newWorkspaceId) {
  try {
    const response = await apiRequest(`/conversations/${conversationId}/move`, {
      method: 'PATCH',
      body: JSON.stringify({
        workspaceId: newWorkspaceId
      })
    });
    
    console.log('Conversación movida:', response.data);
  } catch (error) {
    console.error('Error moviendo conversación:', error);
  }
}

// 15. Archivar workspace
async function archiveWorkspace(workspaceId) {
  try {
    const response = await apiRequest(`/workspaces/${workspaceId}/archive`, {
      method: 'PATCH'
    });
    
    console.log('Workspace archivado:', response.data);
  } catch (error) {
    console.error('Error archivando workspace:', error);
  }
}

// ===== USO EN FRONTEND (React) =====

// Ejemplo de hook personalizado para React
function useSkaneaAPI() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const apiCall = async (endpoint, options = {}) => {
    setLoading(true);
    setError(null);
    
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE}${endpoint}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers
        },
        ...options
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return { apiCall, loading, error };
}

// Ejemplo de uso en componente React
function ChatComponent() {
  const { apiCall, loading, error } = useSkaneaAPI();
  const [conversations, setConversations] = useState([]);

  const loadConversations = async (workspaceId) => {
    try {
      const response = await apiCall(`/conversations/by-date?workspaceId=${workspaceId}`);
      setConversations(response.data);
    } catch (err) {
      console.error('Error cargando conversaciones:', err);
    }
  };

  const sendMessage = async (conversationId, content) => {
    try {
      await apiCall('/messages', {
        method: 'POST',
        body: JSON.stringify({
          conversationId,
          role: 'user',
          content
        })
      });
      
      // Recargar mensajes
      // ... lógica para recargar
    } catch (err) {
      console.error('Error enviando mensaje:', err);
    }
  };

  return (
    <div>
      {loading && <div>Cargando...</div>}
      {error && <div>Error: {error}</div>}
      {/* UI del chat */}
    </div>
  );
}

// Exportar funciones para uso en otros archivos
export {
  createWorkspace,
  getWorkspaces,
  createConversation,
  getConversations,
  createUserMessage,
  createAssistantMessage,
  getMessages,
  ejemploCompleto
}; 