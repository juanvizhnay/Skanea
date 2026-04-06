import React, { useState, useEffect, useCallback } from 'react';
import './ChatHistory.css';
import eliminateIcon from '../assets/eliminate.png';
import editIcon from '../edit.png';
import { useWorkspace } from './WorkspaceContext.jsx';

function ChatHistory({ onClose, onSelectConversation, currentConversationId, onWorkspaceSelect, onConversationDeleted }) {
  const {
    workspaces,
    selectedWorkspace,
    workspaceConversations,
    generalConversations,
    generalConversationsLoaded,
    loading,
    error,
    loadWorkspaces,
    selectWorkspace,
    loadWorkspaceConversations,
    loadGeneralConversations,
    reloadGeneralConversationsSilently,
    setWorkspaces,
    setWorkspaceConversations,
    setGeneralConversations,
    setGeneralConversationsLoaded
  } = useWorkspace();
  
  const [closing, setClosing] = useState(false);
  const [deletingConversation, setDeletingConversation] = useState(null);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState(() => {
    // Usar sessionStorage para detectar reinicios reales (Ctrl+R limpia sessionStorage)
    const appSession = sessionStorage.getItem('skanea_app_session');
    
    if (!appSession) {
      // No hay sesión = reinicio real (Ctrl+R o primer inicio)
      localStorage.removeItem('expandedWorkspaces');
      sessionStorage.setItem('skanea_app_session', 'active');
      return new Set();
    } else {
      // Hay sesión = solo cerrar/abrir historial, mantener workspaces
      const saved = localStorage.getItem('expandedWorkspaces');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    }
  });
  const [localError, setLocalError] = useState(null);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [manualActionTimestamp, setManualActionTimestamp] = useState(0);
  const [showLibraryMenu, setShowLibraryMenu] = useState(false);

  // Obtener el token de autenticación
  const getAuthToken = () => {
    return localStorage.getItem('token');
  };

  // Crear nuevo workspace
  const createWorkspace = async () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Nombre del nuevo espacio:';
    input.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 10000;
      padding: 10px;
      border: 1px solid #333;
      border-radius: 4px;
      background: #1a1a1a;
      color: white;
      font-size: 14px;
      width: 250px;
    `;
    
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 9999;
    `;
    
    document.body.appendChild(overlay);
    document.body.appendChild(input);
    input.focus();
    
    const handleSubmit = async () => {
      const name = input.value.trim();
      
      if (!name) {
        document.body.removeChild(overlay);
        document.body.removeChild(input);
        return;
      }

      try {
        const token = getAuthToken();
        const response = await fetch('http://localhost:10000/api/workspaces', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name })
        });

        if (!response.ok) {
          throw new Error('Error al crear workspace');
        }

        // Obtener el workspace creado con su ID del servidor
        const response_data = await response.json();
        
        // El servidor devuelve { message: "...", workspace: {...} }
        const newWorkspace = response_data.workspace || response_data.data || response_data;
        
        // Agregar inmediatamente el nuevo workspace al estado local
        setWorkspaces(prevWorkspaces => [...prevWorkspaces, newWorkspace]);
      } catch (err) {
        console.error('Error in createWorkspace:', err);
        setLocalError(err.message);
      } finally {
        document.body.removeChild(overlay);
        document.body.removeChild(input);
      }
    };
    
    const handleKeyPress = (e) => {
      if (e.key === 'Enter') {
        handleSubmit();
      } else if (e.key === 'Escape') {
        document.body.removeChild(overlay);
        document.body.removeChild(input);
      }
    };
    
    const handleOverlayClick = () => {
      document.body.removeChild(overlay);
      document.body.removeChild(input);
    };
    
    input.addEventListener('keypress', handleKeyPress);
    overlay.addEventListener('click', handleOverlayClick);
  };

  // Funciones de Biblioteca
  const openLibraryFolder = async () => {
    try {
      const response = await fetch('http://localhost:10000/api/library/open', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`
        }
      });
      
      if (response.ok) {
        setShowLibraryMenu(false);
      } else {
        console.error('Error al abrir carpeta de biblioteca');
      }
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const changeLibraryFolder = async () => {
    try {
      const response = await fetch('http://localhost:10000/api/library/change-path', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`
        }
      });
      
      const data = await response.json();
      
      if (response.ok && data.success) {
        setShowLibraryMenu(false);
        
        // Mostrar diálogo personalizado
        const modal = document.createElement('div');
        modal.style.cssText = `
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 10000;
          background: #1a1a1a;
          border: 1px solid #34e335;
          border-radius: 8px;
          padding: 20px;
          min-width: 350px;
          max-width: 500px;
        `;
        
        modal.innerHTML = `
          <h3 style="margin: 0 0 15px 0; color: #34e335; font-size: 16px;">✅ Ubicación actualizada</h3>
          <p style="margin: 0 0 10px 0; color: white; font-size: 14px; word-break: break-word;">
            Nueva ubicación:<br/>
            <strong>${data.newPath}</strong>
          </p>
          <p style="margin: 10px 0; color: #888; font-size: 13px;">
            ${data.message}
          </p>
          <div style="display: flex; justify-content: flex-end; margin-top: 15px;">
            <button id="okBtn" style="padding: 8px 16px; border: 1px solid #34e335; border-radius: 4px; background: #34e335; color: white; cursor: pointer; font-weight: bold;">
              Entendido
            </button>
          </div>
        `;
        
        const overlay = document.createElement('div');
        overlay.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          z-index: 9999;
        `;
        
        document.body.appendChild(overlay);
        document.body.appendChild(modal);
        
        const okBtn = modal.querySelector('#okBtn');
        okBtn.onclick = () => {
          document.body.removeChild(overlay);
          document.body.removeChild(modal);
        };
      } else {
        setShowLibraryMenu(false);
      }
    } catch (error) {
      console.error('Error:', error);
      setShowLibraryMenu(false);
    }
  };

  // Editar conversación
  const editConversation = async (conversationId, currentTitle) => {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 10000;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 20px;
      min-width: 300px;
    `;
    
    modal.innerHTML = `
      <h3 style="margin: 0 0 15px 0; color: white; font-size: 16px;">Editar conversación</h3>
      <input type="text" id="editInput" value="${currentTitle}" placeholder="Nombre de la conversación" 
        style="width: 100%; padding: 8px; border: 1px solid #555; border-radius: 4px; background: #2a2a2a; color: white; font-size: 14px; box-sizing: border-box;" />
      <div style="display: flex; gap: 10px; margin-top: 15px; justify-content: flex-end;">
        <button id="cancelBtn" style="padding: 8px 16px; border: 1px solid #555; border-radius: 4px; background: #333; color: white; cursor: pointer;">Cancelar</button>
        <button id="acceptBtn" style="padding: 8px 16px; border: 1px solid #34e335; border-radius: 4px; background: #34e335; color: white; cursor: pointer;">Aceptar</button>
      </div>
    `;
    
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 9999;
    `;
    
    document.body.appendChild(overlay);
    document.body.appendChild(modal);
    
    const input = modal.querySelector('#editInput');
    const cancelBtn = modal.querySelector('#cancelBtn');
    const acceptBtn = modal.querySelector('#acceptBtn');
    
    input.focus();
    input.select();
    
    const handleSubmit = async () => {
      const newTitle = input.value.trim();
      if (!newTitle || newTitle === currentTitle) {
        document.body.removeChild(overlay);
        document.body.removeChild(modal);
        return;
      }

      acceptBtn.textContent = 'Guardando...';
      acceptBtn.disabled = true;

      try {
        const token = getAuthToken();
        const response = await fetch(`http://localhost:10000/api/conversations/${conversationId}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ title: newTitle })
        });

        if (!response.ok) {
          throw new Error('Error al actualizar la conversación');
        }

        // Actualizar el estado inmediatamente en lugar de recargar
        if (selectedWorkspace) {
          const updatedConversations = workspaceConversations[selectedWorkspace._id].map(dateGroup => ({
            ...dateGroup,
            conversations: dateGroup.conversations.map(conv => 
              conv._id === conversationId ? { ...conv, title: newTitle } : conv
            )
          }));
          setWorkspaceConversations(prev => ({
            ...prev,
            [selectedWorkspace._id]: updatedConversations
          }));
        } else {
          const updatedConversations = generalConversations.map(dateGroup => ({
            ...dateGroup,
            conversations: dateGroup.conversations.map(conv => 
              conv._id === conversationId ? { ...conv, title: newTitle } : conv
            )
          }));
          setGeneralConversations(updatedConversations);
        }

      } catch (error) {
        console.error('Error:', error);
        alert('Error al actualizar el nombre de la conversación');
      } finally {
        document.body.removeChild(overlay);
        document.body.removeChild(modal);
      }
    };

    const handleCancel = () => {
      document.body.removeChild(overlay);
      document.body.removeChild(modal);
    };
    
    const handleKeyPress = (e) => {
      if (e.key === 'Enter') {
        handleSubmit();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    };
    
    const handleOverlayClick = (e) => {
      if (e.target === overlay) {
        handleCancel();
      }
    };
    
    acceptBtn.addEventListener('click', handleSubmit);
    cancelBtn.addEventListener('click', handleCancel);
    input.addEventListener('keypress', handleKeyPress);
    overlay.addEventListener('click', handleOverlayClick);
  };

  // Editar workspace
  const editWorkspace = async (workspaceId, currentName) => {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 10000;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 20px;
      min-width: 300px;
    `;
    
    modal.innerHTML = `
      <h3 style="margin: 0 0 15px 0; color: white; font-size: 16px;">Editar workspace</h3>
      <input type="text" id="editInput" value="${currentName}" placeholder="Nombre del workspace" 
        style="width: 100%; padding: 8px; border: 1px solid #555; border-radius: 4px; background: #2a2a2a; color: white; font-size: 14px; box-sizing: border-box;" />
      <div style="display: flex; gap: 10px; margin-top: 15px; justify-content: flex-end;">
        <button id="cancelBtn" style="padding: 8px 16px; border: 1px solid #555; border-radius: 4px; background: #333; color: white; cursor: pointer;">Cancelar</button>
        <button id="acceptBtn" style="padding: 8px 16px; border: 1px solid #34e335; border-radius: 4px; background: #34e335; color: white; cursor: pointer;">Aceptar</button>
      </div>
    `;
    
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 9999;
    `;
    
    document.body.appendChild(overlay);
    document.body.appendChild(modal);
    
    const input = modal.querySelector('#editInput');
    const cancelBtn = modal.querySelector('#cancelBtn');
    const acceptBtn = modal.querySelector('#acceptBtn');
    
    input.focus();
    input.select();
    
    const handleSubmit = async () => {
      const newName = input.value.trim();
      if (!newName || newName === currentName) {
        document.body.removeChild(overlay);
        document.body.removeChild(modal);
        return;
      }

      acceptBtn.textContent = 'Guardando...';
      acceptBtn.disabled = true;

      try {
        const token = getAuthToken();
        const response = await fetch(`http://localhost:10000/api/workspaces/${workspaceId}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: newName })
        });

        if (!response.ok) {
          throw new Error('Error al editar workspace');
        }

        // Actualizar inmediatamente el estado local de workspaces
        const updatedWorkspaces = workspaces.map(ws => 
          ws._id === workspaceId ? { ...ws, name: newName } : ws
        );
        setWorkspaces(updatedWorkspaces);
        
        // Si el workspace editado es el seleccionado, actualizar el estado
        if (selectedWorkspace && selectedWorkspace._id === workspaceId) {
          const updatedWorkspace = { ...selectedWorkspace, name: newName };
          selectWorkspace(updatedWorkspace);
        }
      } catch (err) {
        console.error('Error:', err);
        alert('Error al editar el nombre del workspace');
      } finally {
        document.body.removeChild(overlay);
        document.body.removeChild(modal);
      }
    };

    const handleCancel = () => {
      document.body.removeChild(overlay);
      document.body.removeChild(modal);
    };
    
    const handleKeyPress = (e) => {
      if (e.key === 'Enter') {
        handleSubmit();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    };
    
    const handleOverlayClick = (e) => {
      if (e.target === overlay) {
        handleCancel();
      }
    };
    
    acceptBtn.addEventListener('click', handleSubmit);
    cancelBtn.addEventListener('click', handleCancel);
    input.addEventListener('keypress', handleKeyPress);
    overlay.addEventListener('click', handleOverlayClick);
  };

  // Eliminar workspace
  const deleteWorkspace = async (workspaceId, workspaceName) => {
    // Reutilizar el mismo patrón de confirmación interna estilo Skanea
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.55); z-index: 200;
        display: flex; align-items: center; justify-content: center;`;
      const modal = document.createElement('div');
      modal.style.cssText = `
        background: #1a1b21; border: 1px solid #333; border-radius: 12px;
        width: 90%; max-width: 360px; padding: 14px 14px 12px 14px;
        box-shadow: 0 10px 28px rgba(0,0,0,0.35); color: #fff;`;
      modal.innerHTML = `
        <div style="font-size:15px;font-weight:600;margin-bottom:8px;">¿Eliminar workspace?</div>
        <div style="font-size:12px;color:#cfcfcf;margin-bottom:12px;">Se eliminará "${workspaceName}" y no se puede deshacer.</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button data-cancel class="edit-cancel-btn">Cancelar</button>
          <button data-accept class="edit-save-btn" style="background: var(--danger)">Eliminar</button>
        </div>`;
      overlay.addEventListener('click', () => { document.body.removeChild(overlay); resolve(false); });
      modal.addEventListener('click', e => e.stopPropagation());
      modal.querySelector('[data-cancel]').addEventListener('click', () => { document.body.removeChild(overlay); resolve(false); });
      modal.querySelector('[data-accept]').addEventListener('click', () => { document.body.removeChild(overlay); resolve(true); });
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    }).then(async (accepted) => {
      if (!accepted) return;

    try {
      const token = getAuthToken();
      const response = await fetch(`http://localhost:10000/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Error al eliminar workspace');
      }

      // Actualizar inmediatamente el estado local eliminando el workspace
      const updatedWorkspaces = workspaces.filter(ws => ws._id !== workspaceId);
      setWorkspaces(updatedWorkspaces);
      
      // Si el workspace eliminado es el seleccionado, limpiar la selección
      if (selectedWorkspace && selectedWorkspace._id === workspaceId) {
        selectWorkspace(null);
        // No es necesario setConversations([]), ya que las conversaciones generales se cargan del contexto
      }
    } catch (err) {
      setLocalError(err.message);
    }
    });
  };

  // Toggle expandir/colapsar workspace usando el contexto
  const toggleWorkspaceExpansion = async (workspaceId) => {
    // Marcar que el usuario hizo una acción manual para prevenir auto-expansión
    setManualActionTimestamp(Date.now());
    
    const newExpanded = new Set(expandedWorkspaces);
    if (newExpanded.has(workspaceId)) {
      newExpanded.delete(workspaceId);
    } else {
      newExpanded.add(workspaceId);
      // Cargar conversaciones usando el contexto
      await loadWorkspaceConversations(workspaceId);
    }
    setExpandedWorkspaces(newExpanded);
    // Persistir el estado de expansión
    const expandedIds = Array.from(newExpanded);
    localStorage.setItem('expandedWorkspaces', JSON.stringify(expandedIds));
  };

  // Eliminar conversación usando el contexto
  const deleteConversation = async (conversationId) => {
    // Evitar eliminaciones múltiples simultáneas
    if (deletingConversation) return;
    
    // Si es la conversación actual en un workspace, encontrar la siguiente conversación para navegar
    let nextConversationId = null;
    if (selectedWorkspace && conversationId === currentConversationId) {
      const workspaceConvs = workspaceConversations[selectedWorkspace._id];
      if (workspaceConvs) {
        // Buscar todas las conversaciones disponibles (excluyendo la que se va a eliminar)
        const allConversations = workspaceConvs.flatMap(dateGroup => 
          dateGroup.conversations.filter(conv => conv._id !== conversationId)
        );
        
        if (allConversations.length > 0) {
          nextConversationId = allConversations[0]._id;
        }
      }
    }
    
    try {
      setDeletingConversation(conversationId);
      const token = getAuthToken();
      
      const response = await fetch(`http://localhost:10000/api/conversations/${conversationId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Error del servidor:', errorData);
        throw new Error(errorData.message || `Error ${response.status}: ${response.statusText}`);
      }

      await response.json();

      // Notificar que se borró la conversación
      if (onConversationDeleted) {
        onConversationDeleted(conversationId);
      }

      // Forzar recarga de conversaciones después de eliminar
      if (selectedWorkspace) {
        // Limpiar conversaciones del workspace de la memoria para forzar recarga
        setWorkspaceConversations(prev => {
          const newState = { ...prev };
          delete newState[selectedWorkspace._id];
          return newState;
        });
        await loadWorkspaceConversations(selectedWorkspace._id);
        
        // Si la conversación eliminada era la actual, navegar a la siguiente conversación
        if (conversationId === currentConversationId) {
          if (nextConversationId) {
            onSelectConversation(nextConversationId);
          } else {
            onSelectConversation(null);
          }
        }
      } else {
        // Recargar conversaciones generales silenciosamente (sin mostrar loading)
        await reloadGeneralConversationsSilently();
      }
      
      // Limpiar error si existía
      setLocalError(null);
      
    } catch (err) {
      console.error('Error eliminando conversación:', err);
      setLocalError(`Error al eliminar conversación: ${err.message}`);
    } finally {
      setDeletingConversation(null);
    }
  };

  // Función para recargar conversaciones
  const refreshConversations = useCallback(() => {
    if (selectedWorkspace) {
      loadWorkspaceConversations(selectedWorkspace._id);
    } else {
      loadGeneralConversations();
    }
  }, [selectedWorkspace, loadWorkspaceConversations, loadGeneralConversations]);

  function getDateGroup(dateString) {
    const date = new Date(dateString);
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay()); // Domingo
    if (date >= startOfToday) return 'HOY';
    if (date >= startOfWeek) return 'Esta semana';
    return '+ de 1 semana';
  }



  // Cargar conversaciones generales cuando se abre el historial
  useEffect(() => {
    // Solo cargar una vez al montar el componente
    if (initialLoadDone) return;
    
    // Cargar workspaces y conversaciones generales
    loadWorkspaces();
    loadGeneralConversations();
    
    setInitialLoadDone(true);
  }, [initialLoadDone, loadWorkspaces, loadGeneralConversations]); // Dependencias explícitas

  // Recargar conversaciones cuando se crea una nueva
  useEffect(() => {
    if (initialLoadDone && !selectedWorkspace) {
      loadGeneralConversations();
    }
  }, [generalConversations.length, initialLoadDone, selectedWorkspace, loadGeneralConversations]);

  // Expandir automáticamente el workspace de la conversación actual (respetando acciones manuales)
  useEffect(() => {
    if (currentConversationId && workspaces.length > 0) {
      // Si el usuario hizo una acción manual recientemente (últimos 3 segundos), no auto-expandir
      const timeSinceManualAction = Date.now() - manualActionTimestamp;
      if (timeSinceManualAction < 3000) {
        return;
      }
      
      // Buscar en qué workspace está la conversación actual
      for (const workspace of workspaces) {
        const conversations = workspaceConversations[workspace._id];
        if (conversations) {
          const hasCurrentConversation = conversations.some(dateGroup => 
            dateGroup.conversations.some(conv => conv._id === currentConversationId)
          );
          if (hasCurrentConversation && !expandedWorkspaces.has(workspace._id)) {
            const newExpanded = new Set(expandedWorkspaces);
            newExpanded.add(workspace._id);
            setExpandedWorkspaces(newExpanded);
            const expandedIds = Array.from(newExpanded);
            localStorage.setItem('expandedWorkspaces', JSON.stringify(expandedIds));
            break;
          }
        }
      }
    }
  }, [currentConversationId, workspaces, workspaceConversations, expandedWorkspaces, manualActionTimestamp]);



  // Animación de cierre
  const handleClose = () => {
    setClosing(true);
    // Cerrar inmediatamente sin delay para evitar problemas de estado
    onClose();
  };



  // Mostrar pantalla de carga
  if (loading) {
    return (
      <div className={`history-drawer-overlay${closing ? ' closing' : ''}`} onClick={handleClose}>
        <div className={`history-drawer${closing ? ' closing' : ''}`} onClick={e => e.stopPropagation()}>
          <div className="chat-history-header">
            <h3>Historial</h3>
            <button onClick={handleClose} className="close-btn">✕</button>
          </div>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'center', 
            alignItems: 'center', 
            height: '200px',
            color: '#888',
            fontSize: '16px'
          }}>
            Cargando...
          </div>
        </div>
      </div>
    );
  }

  // Mostrar error
  if (error || localError) {
    return (
      <div className={`history-drawer-overlay${closing ? ' closing' : ''}`} onClick={handleClose}>
        <div className={`history-drawer${closing ? ' closing' : ''}`} onClick={e => e.stopPropagation()}>
          <div className="chat-history-header">
            <h3>Historial</h3>
            <button onClick={handleClose} className="close-btn">✕</button>
          </div>
          <div className="error">Error: {error || localError}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`history-drawer-overlay${closing ? ' closing' : ''}`} onClick={handleClose}>
      <div className={`history-drawer${closing ? ' closing' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="chat-history-header">
          <h3>Historial</h3>
          <button onClick={handleClose} className="close-btn">✕</button>
        </div>
        <div className="workspaces-chips-bar">
          <div style={{ marginBottom: '12px', width: '100%' }}>
            {/* Botón Biblioteca - con menú desplegable */}
            <div style={{ position: 'relative', marginBottom: '8px' }}>
              <button
                className="library-btn"
                onClick={() => setShowLibraryMenu(!showLibraryMenu)}
              >
                📚 Biblioteca
              </button>
              
              {showLibraryMenu && (
                <div className="library-menu">
                  <button 
                    className="library-menu-item"
                    onClick={openLibraryFolder}
                  >
                    📂 Mostrar archivos guardados
                  </button>
                  <button 
                    className="library-menu-item"
                    onClick={changeLibraryFolder}
                  >
                    📁 Cambiar ubicación de guardado
                  </button>
                </div>
              )}
            </div>

            <button
              className="new-conversation-btn"
              onClick={() => {
                if (onSelectConversation) onSelectConversation(null);
                if (onClose) onClose();
              }}
            >
              + Nueva conversación
            </button>
          
          <button className="new-workspace-btn" onClick={createWorkspace}>
            + Nuevo workspace
          </button>
          </div>

          
          {workspaces.length > 0 && (
            <div className="workspaces-list" style={{ width: '100%' }}>
              {workspaces.map(workspace => (
                <div key={workspace._id} className="workspace-item">
                  <div
                    className={`workspace-header${selectedWorkspace && selectedWorkspace._id === workspace._id ? ' active' : ''}`}
                    onClick={() => {
                      toggleWorkspaceExpansion(workspace._id);
                      // NO seleccionar automáticamente el workspace, solo expandir/contraer
                    }}
                    style={{
                      cursor: 'pointer',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      transition: 'background-color 0.2s',
                    }}
                  >
                    {selectedWorkspace && selectedWorkspace._id === workspace._id && (
                      <div className="workspace-dot"></div>
                    )}
                    <span style={{
                      marginRight: 8,
                      fontSize: '12px',
                      transition: 'transform 0.2s',
                      transform: expandedWorkspaces.has(workspace._id) ? 'rotate(90deg)' : 'rotate(0deg)'
                    }}>
                      ▶
                    </span>
                    <span style={{ flex: 1, fontSize: '14px' }}>{workspace.name}</span>
                    <div className="workspace-actions">
                      <button
                        className="workspace-action-btn create-btn"
                        onClick={async (e) => {
                          e.stopPropagation();
                          
                          // Expandir el workspace automáticamente
                          if (!expandedWorkspaces.has(workspace._id)) {
                            const newExpanded = new Set(expandedWorkspaces);
                            newExpanded.add(workspace._id);
                            setExpandedWorkspaces(newExpanded);
                            const expandedIds = Array.from(newExpanded);
                            localStorage.setItem('expandedWorkspaces', JSON.stringify(expandedIds));
                          }
                          
                          // Crear nueva conversación en este workspace
                          if (onSelectConversation) onSelectConversation(null);
                          selectWorkspace(workspace);
                          if (onWorkspaceSelect) onWorkspaceSelect(workspace._id);
                          if (onClose) onClose();
                        }}
                        title="Nueva conversación en workspace"
                      >
                        <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#34e335' }}>+</span>
                      </button>
                      <button
                        className="workspace-action-btn edit-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          editWorkspace(workspace._id, workspace.name);
                        }}
                        title="Editar workspace"
                      >
                        <img src={editIcon} alt="editar" style={{ width: '16px', height: '16px' }} />
                      </button>
                      <button
                        className="workspace-action-btn delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteWorkspace(workspace._id, workspace.name);
                        }}
                        title="Eliminar workspace"
                      >
                        <img src={eliminateIcon} alt="eliminar" style={{ width: '16px', height: '16px' }} />
                      </button>
                    </div>
                  </div>
                  
                  {/* Conversaciones del workspace (colapsables) usando el contexto */}
                  {expandedWorkspaces.has(workspace._id) && (
                    <div className="workspace-conversations">
                      {workspaceConversations[workspace._id] ? (
                        workspaceConversations[workspace._id].length > 0 ? (
                          workspaceConversations[workspace._id].map(dateGroup => 
                            dateGroup.conversations.map(conversation => (
                                <div
                                  key={conversation._id}
                                  className={`workspace-conversation-item ${currentConversationId === conversation._id ? 'active' : ''}`}
                                  onClick={() => {
                                    // Seleccionar workspace cuando se selecciona conversación
                                    selectWorkspace(workspace);
                                    if (onWorkspaceSelect) onWorkspaceSelect(workspace._id);
                                    onSelectConversation(conversation._id);
                                  }}
                                >
                                  {currentConversationId === conversation._id && (
                                    <div className="conversation-dot"></div>
                                  )}
                                  <div className="conversation-info">
                                    <div className="conversation-title">{conversation.title}</div>
                                  </div>
                                  <div className="conversation-actions">
                                    <button
                                      className="conversation-edit-btn"
                                      onClick={e => {
                                        e.stopPropagation();
                                        editConversation(conversation._id, conversation.title);
                                      }}
                                      title="Editar conversación"
                                    >
                                      <img src={editIcon} alt="editar" style={{ width: '16px', height: '16px' }} />
                                    </button>
                                    <button
                                      className="conversation-delete-btn"
                                      onClick={e => {
                                        e.stopPropagation();
                                        setConfirmingDeleteId(conversation._id);
                                      }}
                                      title="Borrar conversación"
                                      disabled={deletingConversation === conversation._id}
                                    >
                                      {deletingConversation === conversation._id ? '⏳' : <img src={eliminateIcon} alt="eliminar" style={{ width: '16px', height: '16px' }} />}
                                    </button>
                                  </div>
                                </div>
                            ))
                          ).flat()
                        ) : (
                          <div style={{ 
                            fontSize: '12px', 
                            color: '#888', 
                            padding: '8px',
                            textAlign: 'center'
                          }}>
                            No hay conversaciones en este workspace
                          </div>
                        )
                      ) : (
                        <div style={{ 
                          fontSize: '12px', 
                          color: '#888', 
                          padding: '8px',
                          textAlign: 'center'
                        }}>
                          Cargando...
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        
        {/* Mostrar conversaciones generales siempre */}
        <div className="conversations-container">
            {generalConversationsLoaded && generalConversations.length > 0 && (
              <div className="conversations-list">
                {/* Agrupar por HOY, Esta semana, + de 1 semana */}
                {(() => {
                  const groups = {};
                  generalConversations.forEach(dateGroup => {
                    dateGroup.conversations.forEach(conversation => {
                      const dateKey = getDateGroup(conversation.stats?.lastMessageAt || conversation.createdAt);
                      if (!groups[dateKey]) groups[dateKey] = [];
                      groups[dateKey].push(conversation);
                    });
                  });
                  return ['HOY', 'Esta semana', '+ de 1 semana'].map(group =>
                    groups[group] && groups[group].length > 0 ? (
                      <div key={group} className="date-group">
                        <div className="date-header">{group}</div>
                        {groups[group].map(conversation => (
                          <div
                            key={conversation._id}
                            className={`conversation-item ${currentConversationId === conversation._id ? 'active' : ''}`}
                            onClick={() => {
                              // Limpiar selección de workspace al seleccionar conversación general
                              selectWorkspace(null);
                              if (onWorkspaceSelect) onWorkspaceSelect(null);
                              onSelectConversation(conversation._id);
                            }}
                          >
                            {currentConversationId === conversation._id && (
                              <div className="conversation-dot"></div>
                            )}
                            <div className="conversation-info">
                              <div className="conversation-title">{conversation.title}</div>
                            </div>
                            <div className="conversation-actions">
                              <button
                                className="conversation-edit-btn"
                                onClick={e => {
                                  e.stopPropagation();
                                  editConversation(conversation._id, conversation.title);
                                }}
                                title="Editar conversación"
                              >
                                <img src={editIcon} alt="editar" style={{ width: '16px', height: '16px' }} />
                              </button>
                              <button
                                className="conversation-delete-btn"
                                onClick={e => {
                                  e.stopPropagation();
                                  setConfirmingDeleteId(conversation._id);
                                }}
                                title="Borrar conversación"
                                disabled={deletingConversation === conversation._id}
                              >
                                {deletingConversation === conversation._id ? '⏳' : <img src={eliminateIcon} alt="eliminar" style={{ width: '16px', height: '16px' }} />}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null
                  );
                })()}
              </div>
            )}
        </div>
      </div>
      {confirmingDeleteId && (
        <div
          onClick={() => setConfirmingDeleteId(null)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#1a1b21',
              border: '1px solid #333',
              borderRadius: '12px',
              width: '90%',
              maxWidth: '360px',
              padding: '14px 14px 12px 14px',
              boxShadow: '0 10px 28px rgba(0,0,0,0.35)'
            }}
          >
            <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: 8, color: '#fff' }}>
              ¿Borrar esta conversación?
            </div>
            <div style={{ fontSize: '12px', color: '#cfcfcf', marginBottom: 12 }}>
              Esta acción no se puede deshacer.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="edit-cancel-btn"
                onClick={() => setConfirmingDeleteId(null)}
              >
                Cancelar
              </button>
              <button
                className="edit-save-btn"
                style={{ background: 'var(--danger)' }}
                onClick={() => {
                  const id = confirmingDeleteId;
                  setConfirmingDeleteId(null);
                  if (id) deleteConversation(id);
                }}
              >
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatHistory;