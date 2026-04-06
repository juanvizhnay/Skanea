import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const WorkspaceContext = createContext();

export function WorkspaceProvider({ children }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState(null);
  const [workspaceConversations, setWorkspaceConversations] = useState({});
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [generalConversations, setGeneralConversations] = useState([]);
  const [generalConversationsLoaded, setGeneralConversationsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Cargar workspaces solo si no hay en memoria
  const loadWorkspaces = useCallback(async () => {
    if (workspaces.length > 0) {
      setLoading(false);
      return;
    }
    
    const token = localStorage.getItem('token');
    
    if (!token) {
      setWorkspaces([]);
      setError('No hay sesión activa. Por favor, inicia sesión.');
      setLoading(false);
      return;
    }
    
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('http://localhost:10000/api/workspaces', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Error del servidor:', errorText);
        
        if (response.status === 401) {
          localStorage.removeItem('token');
          localStorage.removeItem('currentWorkspaceId');
          localStorage.removeItem('currentConversationId');
          // Recargar la página para ir al login
          window.location.reload();
          return;
        }
        
        throw new Error(`Error al cargar workspaces: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      setWorkspaces(data.data || []);
    } catch (err) {
      console.error('Error cargando workspaces:', err);
      
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        setWorkspaces([]);
        setError(null);
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [workspaces.length]);

  // Cargar conversaciones de un workspace solo si no están en memoria
  const loadWorkspaceConversations = useCallback(async (workspaceId) => {
    if (workspaceConversations[workspaceId]) return;
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`http://localhost:10000/api/conversations/by-date?workspaceId=${workspaceId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Error al cargar conversaciones del workspace');
      }

      const data = await response.json();
      setWorkspaceConversations(prev => ({ ...prev, [workspaceId]: data.data || [] }));
    } catch (err) {
      console.error('Error cargando conversaciones:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [workspaceConversations]);

  // Función para forzar recarga de conversaciones de workspace (sin condiciones)
  const forceReloadWorkspaceConversations = useCallback(async (workspaceId) => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`http://localhost:10000/api/conversations/by-date?workspaceId=${workspaceId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Error al cargar conversaciones del workspace');
      }

      const data = await response.json();
      setWorkspaceConversations(prev => ({ ...prev, [workspaceId]: data.data || [] }));
    } catch (err) {
      console.error('Error cargando conversaciones del workspace:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Cargar conversaciones generales solo si no están en memoria
  const loadGeneralConversations = useCallback(async () => {
    if (generalConversationsLoaded && generalConversations.length > 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setGeneralConversations([]);
        setGeneralConversationsLoaded(true);
        setLoading(false);
        return;
      }

      const response = await fetch('http://localhost:10000/api/conversations/by-date', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Error al cargar conversaciones generales');
      }

      const data = await response.json();
      // Filtrar solo las conversaciones generales (sin workspaceId)
      const soloGenerales = data.data.map(dateGroup => ({
        ...dateGroup,
        conversations: dateGroup.conversations.filter(c => !c.workspaceId)
      })).filter(dateGroup => dateGroup.conversations.length > 0);
      
      setGeneralConversations(soloGenerales);
      setGeneralConversationsLoaded(true);
    } catch (err) {
      console.error('Error cargando conversaciones generales:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [generalConversationsLoaded, generalConversations.length]);

  // Función para forzar recarga de conversaciones generales (sin condiciones)
  const forceReloadGeneralConversations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setGeneralConversations([]);
        setGeneralConversationsLoaded(true);
        setLoading(false);
        return;
      }

      const response = await fetch('http://localhost:10000/api/conversations/by-date', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(localStorage.getItem('debugUI') === '1' ? { 'x-debug-markdown': '1' } : {})
        }
      });

      if (!response.ok) {
        throw new Error('Error al cargar conversaciones generales');
      }

      const data = await response.json();
      // Filtrar solo las conversaciones generales (sin workspaceId)
      const soloGenerales = data.data.map(dateGroup => ({
        ...dateGroup,
        conversations: dateGroup.conversations.filter(c => !c.workspaceId)
      })).filter(dateGroup => dateGroup.conversations.length > 0);
      
      setGeneralConversations(soloGenerales);
      setGeneralConversationsLoaded(true);
    } catch (err) {
      console.error('Error cargando conversaciones generales:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Función para recargar conversaciones generales sin mostrar loading (para borrar)
  const reloadGeneralConversationsSilently = useCallback(async () => {
    setError(null);
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setGeneralConversations([]);
        setGeneralConversationsLoaded(true);
        return;
      }

      const response = await fetch('http://localhost:10000/api/conversations/by-date', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(localStorage.getItem('debugUI') === '1' ? { 'x-debug-markdown': '1' } : {})
        }
      });

      if (!response.ok) {
        throw new Error('Error al cargar conversaciones generales');
      }

      const data = await response.json();
      // Filtrar solo las conversaciones generales (sin workspaceId)
      const soloGenerales = data.data.map(dateGroup => ({
        ...dateGroup,
        conversations: dateGroup.conversations.filter(c => !c.workspaceId)
      })).filter(dateGroup => dateGroup.conversations.length > 0);
      
      setGeneralConversations(soloGenerales);
      setGeneralConversationsLoaded(true);
    } catch (err) {
      console.error('Error cargando conversaciones generales:', err);
      setError(err.message);
    }
  }, []);

  // Seleccionar workspace
  const selectWorkspace = (workspace) => {
    setSelectedWorkspace(workspace);
    setSelectedConversation(null);
    if (workspace) {
      localStorage.setItem('currentWorkspaceId', workspace._id);
    } else {
      localStorage.removeItem('currentWorkspaceId');
    }
  };

  // Limpiar localStorage al inicializar para evitar selección automática
  useEffect(() => {
    // Limpiar selección de workspace guardada previamente
    localStorage.removeItem('currentWorkspaceId');
  }, []);

  // Seleccionar conversación
  const selectConversation = (conversation) => {
    setSelectedConversation(conversation);
    if (conversation) {
      localStorage.setItem('currentConversationId', conversation._id);
    } else {
      localStorage.removeItem('currentConversationId');
    }
  };

  // Al montar, solo cargar conversación seleccionada si hay workspace seleccionado
  // NO cargar automáticamente workspace para evitar selección automática
  useEffect(() => {
    // Solo cargar conversación si ya hay un workspace seleccionado manualmente
    const convId = localStorage.getItem('currentConversationId');
    if (convId && selectedWorkspace && workspaceConversations[selectedWorkspace._id]) {
      const conversations = workspaceConversations[selectedWorkspace._id];
      let foundConv = null;
      for (const dateGroup of conversations) {
        foundConv = dateGroup.conversations.find(c => c._id === convId);
        if (foundConv) break;
      }
      if (foundConv) setSelectedConversation(foundConv);
    }
  }, [selectedWorkspace, workspaceConversations]);

  return (
    <WorkspaceContext.Provider value={{
      workspaces,
      selectedWorkspace,
      workspaceConversations,
      selectedConversation,
      generalConversations,
      generalConversationsLoaded,
      loading,
      error,
      loadWorkspaces,
      loadWorkspaceConversations,
      forceReloadWorkspaceConversations,
      loadGeneralConversations,
      forceReloadGeneralConversations,
      reloadGeneralConversationsSilently,
      selectWorkspace,
      selectConversation,
      setWorkspaces,
      setWorkspaceConversations,
      setGeneralConversations,
      setGeneralConversationsLoaded
    }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
} 