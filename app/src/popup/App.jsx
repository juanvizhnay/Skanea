import React, { useEffect, useState } from 'react';
import Chat from './Chat.jsx';
import ChatHistory from './ChatHistory.jsx';
import SettingsOverlay from './SettingsOverlay.jsx';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext.jsx';
import logoPro from '../../docs/SkaneaPro.png';
import logoBasic from '../../docs/SkaneaBasic.png';
import logoGratis from '../../docs/SkaneaGratis.png';
import logoUltimate from '../../docs/SkaneaUltimate.png';
import historyIcon from '../assets/history.png';
import configIcon from '../assets/config.png';

// Componente de login/confirmaciones para Electron
function Login({ onLogin }) {
  const [queryState] = useState(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      return {
        connected: p.get('connected') || '',
        loggedout: p.get('loggedout') || ''
      };
    } catch {
      return { connected: '', loggedout: '' };
    }
  });

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onAuthToken((token) => {
        localStorage.setItem('token', token);
        onLogin(token);
      });
    }
  }, [onLogin]);

  const handleLogin = () => {
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal('http://localhost:5174/login?redirect=http://localhost:5175/auth/callback');
    } else {
      window.open('http://localhost:5174/login?redirect=http://localhost:5175/auth/callback', '_blank');
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', background: '#0d0f14' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(700px 500px at 20% 20%, rgba(126,231,135,0.12), transparent 60%), radial-gradient(900px 600px at 80% 70%, rgba(105,112,255,0.12), transparent 60%)', filter: 'blur(12px)', opacity: .55 }} aria-hidden="true" />
      <div style={{ position: 'relative', width: 'min(560px, 92vw)', background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))', border: '1px solid #222835', borderRadius: 16, padding: 28, boxShadow: '0 10px 40px rgba(0,0,0,.35)', textAlign: 'center' }}>
        <div style={{ fontWeight: 900, letterSpacing: 2, background: 'linear-gradient(90deg, #7ee787, #a78bfa, #f472b6)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', marginBottom: 8 }}>SKANEA</div>
        {queryState.connected === 'google' ? (
          <>
            <h2 style={{ margin: '4px 0 12px' }}>¡Conectaste Google correctamente!</h2>
            <p style={{ color: '#9aa3b2', marginBottom: 18 }}>Tu cuenta de Google quedó vinculada a Skanea. Ya puedes volver a la app.</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={handleLogin} className="btn btn-primary" style={{ background: 'linear-gradient(90deg, #7ee787, #b2f5ea)', color: '#111', border: 'none' }}>Cambiar de cuenta</button>
            </div>
          </>
        ) : queryState.loggedout ? (
          <>
            <h2 style={{ margin: '4px 0 12px' }}>Sesión cerrada</h2>
            <p style={{ color: '#9aa3b2', marginBottom: 18 }}>Tu sesión se cerró correctamente. Inicia sesión de nuevo para continuar.</p>
            <button onClick={handleLogin} className="btn btn-primary" style={{ background: 'linear-gradient(90deg, #7ee787, #b2f5ea)', color: '#111', border: 'none' }}>Iniciar sesión</button>
          </>
        ) : (
          <>
            <h2 style={{ margin: '4px 0 12px' }}>Inicia sesión en Skanea</h2>
            <p style={{ color: '#9aa3b2', marginBottom: 18 }}>Serás redirigido a la web para autenticarte de forma segura.</p>
            <button onClick={handleLogin} className="btn btn-primary" style={{ background: 'linear-gradient(90deg, #7ee787, #b2f5ea)', color: '#111', border: 'none' }}>Iniciar sesión con Skanea</button>
          </>
        )}
      </div>
    </div>
  );
}

// Por ahora, el plan es fijo. En el futuro, esto vendrá del usuario autenticado.
const userPlan = 'pro'; // 'pro', 'basic', 'gratis', 'ultimate'

const planLogos = {
  pro: logoPro,
  basic: logoBasic,
  gratis: logoGratis,
  ultimate: logoUltimate,
};

function parseJwt(token) {
  if (!token) return null;
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

function AppContent() {
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [historyMode, setHistoryMode] = useState('general'); // 'general' o 'workspace'
  const userData = parseJwt(token);
  const userEmail = userData?.email || 'usuario@skanea.com';
  
  // Usar el contexto para acceder a las funciones de recarga
  const { forceReloadGeneralConversations, forceReloadWorkspaceConversations } = useWorkspace();

  // Selecciona el logo según el plan (por ahora, pro)
  const logo = planLogos[userPlan] || logoPro;

  // Asegura que el body tenga la clase de tema correcta al cargar la app
  useEffect(() => {
    const saved = localStorage.getItem('skanea_theme') || 'black';
    document.body.classList.remove('theme-black', 'theme-original', 'theme-light');
    document.body.classList.add(`theme-${saved}`);
  }, []);

  // Manejar selección de conversación
  const handleConversationSelect = (conversationId) => {
    setCurrentConversationId(conversationId);
    setShowHistory(false);
  };

  // Manejar selección de workspace
  const handleWorkspaceSelect = (workspaceId) => {
    setCurrentWorkspaceId(workspaceId);
    setHistoryMode(workspaceId ? 'workspace' : 'general');
  };

  // Manejar creación de nueva conversación
  const handleConversationCreated = async (conversationId) => {
    setCurrentConversationId(conversationId);
    
    // Forzar recarga inmediata del historial según el contexto
    
    // Esperar un poco para asegurar que el servidor ha procesado la conversación
    await new Promise(resolve => setTimeout(resolve, 200));
    
    if (currentWorkspaceId) {
      try {
        await forceReloadWorkspaceConversations(currentWorkspaceId);
      } catch (error) {
        console.error('Error recargando conversaciones de workspace:', error);
      }
    } else {
      try {
        await forceReloadGeneralConversations();
      } catch (error) {
        console.error('Error recargando conversaciones generales:', error);
      }
    }
  };

  // Manejar cuando se borra una conversación
  const handleConversationDeleted = (deletedConversationId) => {
    // Si la conversación borrada es la actual, limpiar la selección
    if (currentConversationId === deletedConversationId) {
      setCurrentConversationId(null);
    }
  };

  // Función para cerrar sesión
  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('shownMessages'); // Limpiar mensajes mostrados al cerrar sesión
    setToken(null);
  };

  if (!token) {
    return <Login onLogin={setToken} />;
  }

  return (
    <div className="app-container">
      {showHistory && (
        <ChatHistory 
          onClose={() => setShowHistory(false)} 
          onSelectConversation={handleConversationSelect}
          currentConversationId={currentConversationId}
          onWorkspaceSelect={handleWorkspaceSelect}
          onConversationDeleted={handleConversationDeleted}
        />
      )}
      <div className="chat-area">
        <div className="top-bar">
          <button
            className="history-btn icon-btn"
            onClick={() => setShowHistory(!showHistory)}
            aria-label="Historial"
            title="Historial"
          >
            <img src={historyIcon} alt="historial" style={{ width: '30px', height: '30px', objectFit: 'contain', display: 'block' }} />
          </button>
          <div className="logo-container">
            <img src={logo} alt="Skanea logo" className="logo" />
          </div>
          <button
            className="settings-btn icon-btn"
            onClick={() => setShowSettings(true)}
            aria-label="Ajustes"
            title="Ajustes"
          >
            <img src={configIcon} alt="configuración" style={{ width: '28px', height: '28px', objectFit: 'contain', display: 'block' }} />
          </button>
        </div>
        <Chat 
          currentConversationId={currentConversationId}
          onConversationCreated={handleConversationCreated}
        />
      </div>
      {showSettings && <SettingsOverlay onClose={() => setShowSettings(false)} onLogout={handleLogout} user={{ email: userEmail }} />}
    </div>
  );
}

function App() {
  return (
    <WorkspaceProvider>
      <AppContent />
    </WorkspaceProvider>
  );
}

export default App;
