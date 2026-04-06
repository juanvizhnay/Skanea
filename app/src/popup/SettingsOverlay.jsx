import React, { useState, useEffect } from 'react';

function getInitial(email) {
  if (!email) return '?';
  return email[0].toUpperCase();
}

const themes = [
  { value: 'black', label: 'Black (Negro OLED)' },
  { value: 'original', label: 'Original' },
  { value: 'light', label: 'Light (Blanco)' },
];

function getActiveTheme() {
  // Busca la clase en el body o en localStorage
  const classList = document.body.classList;
  if (classList.contains('theme-black')) return 'black';
  if (classList.contains('theme-light')) return 'light';
  return classList.contains('theme-original') ? 'original' : (localStorage.getItem('skanea_theme') || 'original');
}

function SettingsOverlay({ onClose, user = { email: 'usuario@skanea.com' }, onLogout }) {
  const [closing, setClosing] = useState(false);
  const [theme, setTheme] = useState(getActiveTheme());
  const [connectors, setConnectors] = useState([]);
  const [model, setModel] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(400);
  const [isResizing, setIsResizing] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [autoSaveFiles, setAutoSaveFiles] = useState(() => {
    // Cargar valor inicial directamente desde localStorage
    const savedPref = localStorage.getItem('skanea_auto_save_files');
    return savedPref === 'true';
  });
  const [autoSaveLoaded, setAutoSaveLoaded] = useState(false);

  // Opciones del dropdown de modelos
  const modelOptions = [
    { value: 'cloud:o3', label: 'OpenAI o3 (cloud)' },
    { value: 'mistral:instruct', label: 'Mistral 7B Instruct (local)' },
    { value: 'llm-lite', label: 'Llama 3.2 1B Instruct (llm-lite)' }
  ];

  // Click fuera del dropdown para cerrarlo
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownOpen && !event.target.closest('.custom-dropdown')) {
        setDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  // Sincroniza el select con el tema activo cada vez que se abre el panel
  useEffect(() => {
    setTheme(getActiveTheme());
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    document.body.classList.remove('theme-black', 'theme-original', 'theme-light');
    document.body.classList.add(`theme-${theme}`);
    localStorage.setItem('skanea_theme', theme);
  }, [theme]);

  // Cargar conectores al abrir el panel
  useEffect(() => {
    async function loadConnectors() {
      try {
        const token = localStorage.getItem('token');
        if (!token) return;
        const resp = await fetch('http://localhost:10000/api/connectors', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await resp.json();
        if (data && data.connectors) setConnectors(data.connectors);
      } catch (e) {
        console.error('Error cargando conectores', e);
      }
    }
    loadConnectors();
  }, []);

  // Cargar selección de modelo actual
  useEffect(() => {
    async function loadModelSelection() {
      try {
        const token = localStorage.getItem('token');
        if (!token) return;
        const resp = await fetch('http://localhost:10000/api/models/selection', {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await resp.json();
        if (data && (data.selected || data.selected === null)) {
          setModel(data.selected || 'cloud:o3');
        }
      } catch (e) {
        console.error('Error cargando selección de modelo', e);
      }
    }
    loadModelSelection();
  }, []);

  // Marcar que ya se cargó la preferencia inicial
  useEffect(() => {
    setAutoSaveLoaded(true);
  }, []);

  // Guardar preferencia de guardado automático (solo después de la carga inicial)
  useEffect(() => {
    if (autoSaveLoaded) {
      localStorage.setItem('skanea_auto_save_files', autoSaveFiles);
    }
  }, [autoSaveFiles, autoSaveLoaded]);

  async function saveModelSelection(next) {
    try {
      setSavingModel(true);
      const token = localStorage.getItem('token');
      if (!token) {
        // Guardar override local en caso de no sesión
        localStorage.setItem('skanea_model_override', next);
        setModel(next);
        return;
      }
      const resp = await fetch('http://localhost:10000/api/models/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: next })
      });
      if (resp.status === 401 || resp.status === 403) {
        // Fallback: persistir sólo local
        localStorage.setItem('skanea_model_override', next);
        setModel(next);
        return;
      }
      if (!resp.ok) {
        const e = await resp.json().catch(()=>({}));
        throw new Error(e.error || `HTTP ${resp.status}`);
      }
      const j = await resp.json();
      setModel(j.selected || next);
      // Sincroniza override local para que el chat lo use de inmediato
      localStorage.setItem('skanea_model_override', j.selected || next);
    } catch (e) {
      alert('No se pudo guardar el modelo: ' + (e && e.message ? e.message : 'Error desconocido'));
    } finally {
      setSavingModel(false);
    }
  }

  // Manejar resize del drawer
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizing) return;
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth >= 300 && newWidth <= 600) {
        setDrawerWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const handleClose = () => {
    setClosing(true);
    setTimeout(() => {
      onClose();
}, 300); // Debe coincidir con la duración de la animación CSS
  };

  const startResize = (e) => {
    e.preventDefault();
    setIsResizing(true);
  };

  // Funciones del dropdown
  const handleDropdownSelect = async (value) => {
    setDropdownOpen(false);
    await saveModelSelection(value);
  };

  const getSelectedOption = () => {
    return modelOptions.find(opt => opt.value === (model || 'cloud:o3')) || modelOptions[0];
  };

  return (
    <div className={`settings-drawer-overlay${closing ? ' closing' : ''}`} onClick={handleClose}>
      <div
        className={`settings-drawer${closing ? ' closing' : ''}`}
        style={{ width: `${drawerWidth}px` }}
        onClick={e => e.stopPropagation()}
      >
        <div className="resize-handle" onMouseDown={startResize} />
        <button className="close-btn" onClick={handleClose} aria-label="Cerrar">
          ✕
        </button>
        <div className="settings-avatar-section">
          <div className="settings-avatar">
            <span>{getInitial(user.email)}</span>
          </div>
          <div className="settings-email">{user.email}</div>
        </div>
        <div className="settings-options">
          <div className="settings-option">
            <label style={{ fontWeight: 'bold', marginRight: 8, marginBottom: 8, display: 'block' }}>Modelo:</label>
            <div className="custom-dropdown" style={{ position: 'relative' }}>
              <button
                className={`dropdown-trigger ${savingModel ? 'disabled' : ''}`}
                onClick={() => !savingModel && setDropdownOpen(!dropdownOpen)}
                disabled={savingModel}
                aria-expanded={dropdownOpen}
              >
                <span className="dropdown-text">{getSelectedOption().label}</span>
                <span className={`dropdown-arrow ${dropdownOpen ? 'open' : ''}`}>▾</span>
              </button>

              {dropdownOpen && (
                <div className="dropdown-menu">
                  {modelOptions.map((option) => (
                    <button
                      key={option.value}
                      className={`dropdown-option ${option.value === (model || 'cloud:o3') ? 'selected' : ''}`}
                      onClick={() => handleDropdownSelect(option.value)}
                    >
                      <span className="option-text">{option.label}</span>
                      {option.value === (model || 'cloud:o3') && (
                        <span className="option-check">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="model-description" style={{ opacity: 0.8, fontSize: '0.9rem', marginTop: '8px', marginLeft: '0px' }}>
            {(() => {
              const selectedModel = model || 'cloud:o3';
              if (selectedModel === 'cloud:o3') return 'OpenAI o3 — Recomendado si tienes suscripción';
              if (selectedModel === 'mistral:instruct') return 'Mistral 7B — Recomendado para PCs gama media/alta';
              if (selectedModel === 'llm-lite') return 'Llama 3.2 1B — Recomendado para PCs de bajos recursos';
              return 'Los modelos locales no consumen API.';
            })()}
          </div>
          <div className="settings-option" style={{ opacity: 0.7, fontSize: '0.85rem', marginTop: '4px' }}>
            Puedes cambiar de modelo en cualquier momento. Los modelos locales no consumen API.
          </div>
          <div className="settings-option">
            <label htmlFor="theme-select" style={{ fontWeight: 'bold', marginRight: 8 }}>Tema:</label>
            <select
              id="theme-select"
              value={theme}
              onChange={e => setTheme(e.target.value)}
              style={{
                background: 'var(--bg-panel-alt)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '0.4rem 0.7rem',
                fontSize: '1rem',
                marginLeft: 4,
              }}
            >
              {themes.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <button className="settings-option">Idioma: Español</button>

          {/* Toggle para guardado automático de archivos */}
          <div className="settings-option" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontWeight: 'bold' }}>Guardar automáticamente archivos generados</div>
              <div style={{ fontSize: '0.85rem', opacity: 0.7 }}>
                Los archivos se guardarán localmente al ser generados
              </div>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={autoSaveFiles}
                onChange={(e) => setAutoSaveFiles(e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="settings-option connectors" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ fontWeight: 'bold' }}>Conectar cuenta de Google</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div
                className="connector-btn connector-google"
                onMouseEnter={e => e.currentTarget.classList.add('show-action')}
                onMouseLeave={e => e.currentTarget.classList.remove('show-action')}
                onClick={async (ev) => {
                  ev.stopPropagation();
                  const g = connectors.find(c => c.provider === 'google' && !c.revoked_at);
                  const isConnected = !!g;
                  try {
                    const token = localStorage.getItem('token');
                    if (isConnected) {
                      // Desconectar
                      const resp = await fetch('http://localhost:10000/api/connectors/google', {
                        method: 'DELETE',
                        headers: { Authorization: `Bearer ${token}` }
                      });
                      const j = await resp.json();
                      if (!j.success) alert('No se pudo desconectar Google');
                    } else {
                      // Conectar
                      const resp = await fetch('http://localhost:10000/api/connectors/google/init', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
                      });
                      const data = await resp.json();
                      if (data.url) {
                        if (window.electronAPI && window.electronAPI.openExternal) {
                          window.electronAPI.openExternal(data.url);
                        } else {
                          window.open(data.url, '_blank');
                        }
                      }
                    }
                  } catch (e) {
                    console.error('Error en acción de Google', e);
                  } finally {
                    try {
                      const token = localStorage.getItem('token');
                      const list = await fetch('http://localhost:10000/api/connectors', { headers: { Authorization: `Bearer ${token}` } });
                      const j = await list.json();
                      if (j && j.connectors) setConnectors(j.connectors);
                    } catch {}
                  }
                }}
              >
                {(() => {
                  const g = connectors.find(c => c.provider === 'google' && !c.revoked_at);
                  const isConnected = !!g;
                  return (
                    <>
                      <div className="connector-content">
                        <div className="google-logo-container">
                          <img src="/resources/google-logo.png" alt="Google" className="google-logo" />
                        </div>
                        <div className="connector-text-container">
                          <span className="connector-status">
                            {isConnected ? `Google conectado${g?.account_email ? ` (${g.account_email})` : ''}` : 'Conectar con Google'}
                          </span>
                          <span className="connector-action">
                            {isConnected ? 'Desconectar Google' : 'Conectar con Google'}
                          </span>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
              {/* WhatsApp removido por solicitud */}
              {/* Instagram deshabilitado */}
            </div>
          </div>
          {/* Atajos de teclado */}
          <ShortcutsSection />

          <button className="settings-option logout" onClick={onLogout}>Cerrar sesión</button>
        </div>
      </div>
    </div>
  );
}

function captureAccelerator(e) {
  // Construye un acelerador estilo Electron con orden estable
  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  // Mapear teclas especiales
  const mapKey = (k) => {
    if (!k) return '';
    if (k === ' ') return 'Space';
    const special = {
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Escape: 'Esc',
      Enter: 'Enter',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Tab: 'Tab'
    };
    if (special[k]) return special[k];
    if (k.length === 1) return k.toUpperCase();
    return k;
  };
  const base = e.key;
  // Ignorar si solo presionan un modificador
  if (['Control','Shift','Alt','Meta'].includes(base)) return '';
  const last = mapKey(base);
  if (last && !['Control','Shift','Alt','Super'].includes(last)) parts.push(last);
  return parts.join('+');
}

function ShortcutsSection() {
  const [shortcuts, setShortcuts] = useState({ toggle:'Control+Shift+Z', screenshot:'Control+Shift+S', send:'Control+Enter', mic:'Control+Shift+M', copy:'Control+Shift+C' });
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    try {
      if (window.electronAPI && window.electronAPI.loadSettings) {
        window.electronAPI.loadSettings().then(s => {
          if (s && s.shortcuts) setShortcuts(s.shortcuts);
        });
      }
    } catch {}
  }, []);

  const startCapture = (name) => setEditing(name);
  const stopCapture = () => setEditing(null);

  const handleKeyDown = (e) => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    let acc = captureAccelerator(e);
    if (!acc || acc.length === 0) return;
    const next = { ...shortcuts, [editing]: acc };
    setShortcuts(next);
    try { window.electronAPI && window.electronAPI.saveSettings && window.electronAPI.saveSettings({ shortcuts: next }); } catch {}
    stopCapture();
  };

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (ev) => handleKeyDown(ev);
    const onKeyUp = (ev) => {
      // Si usuario suelta y no construimos combinación, cancela captura
      // (ayuda a evitar capturar una sola tecla por error)
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
    // eslint-disable-next-line
  }, [editing]);

  const Row = ({ name, label }) => (
    <div className="settings-option" style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
      <div style={{ fontWeight: 'bold' }}>{label}</div>
      <button
        className="btn"
        onClick={() => startCapture(name)}
        style={{
          border:'1px solid var(--border)', borderRadius:8, padding:'6px 10px', background:'var(--bg-panel)', color:'var(--text)'
        }}
      >
        {editing === name ? 'Presiona combinación…' : (shortcuts[name] || '—')}
      </button>
    </div>
  );

  return (
    <div className="settings-option" style={{ display:'flex', flexDirection:'column', gap:10 }}>
      <div style={{ fontWeight:'bold', marginBottom: 4 }}>Atajos de teclado</div>
      <Row name="toggle" label="Abrir/Cerrar Skanea" />
      <Row name="screenshot" label="Tomar captura (subir sin enviar)" />
      <Row name="send" label="Enviar mensaje" />
      <Row name="mic" label="Activar micrófono" />
      <Row name="copy" label="Copiar respuesta" />
      <div className="hint" style={{ opacity: .7, fontSize: 12 }}>Evita usar combinaciones ya usadas por tu sistema o por otras apps.</div>
    </div>
  );
}

export default SettingsOverlay;
