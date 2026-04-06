const { app, BrowserWindow, globalShortcut, ipcMain, shell, screen } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { startServer, stopServer } = require('./server-runner');

let mainWindow;
let settings = null;
let lastBounds = null;
let lastIsMaximized = false;
let lastIsFullHeight = false; // ocupa toda el área de trabajo en alto, sin estar maximizada

function createWindow() {
  // Crear la ventana del navegador
  mainWindow = new BrowserWindow({
    width: lastBounds?.width || 400,
    height: lastBounds?.height || 600,
    x: lastBounds?.x,
    y: lastBounds?.y,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    resizable: true,
    title: 'Skanea',
    icon: path.join(__dirname, 'resources/icon.png')
  });

  // En desarrollo, cargar desde el servidor de desarrollo de Vite
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // En producción, cargar el archivo HTML construido
    mainWindow.loadFile(path.join(__dirname, '../app/dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.on('resize', () => {
    try {
      if (mainWindow.isMinimized() || !mainWindow.isVisible()) return;
      if (mainWindow.isMaximized()) return; // normal bounds se capturan en maximize
      lastBounds = mainWindow.getBounds();
      try {
        const display = screen.getDisplayMatching(lastBounds);
        const area = display.workArea;
        lastIsFullHeight = (Math.abs(lastBounds.y - area.y) <= 1) && (lastBounds.height >= area.height - 1);
      } catch {}
    } catch {}
  });
  mainWindow.on('move', () => {
    try {
      if (mainWindow.isMinimized() || !mainWindow.isVisible()) return;
      if (mainWindow.isMaximized()) return;
      lastBounds = mainWindow.getBounds();
      try {
        const display = screen.getDisplayMatching(lastBounds);
        const area = display.workArea;
        lastIsFullHeight = (Math.abs(lastBounds.y - area.y) <= 1) && (lastBounds.height >= area.height - 1);
      } catch {}
    } catch {}
  });
  mainWindow.on('maximize', () => {
    try {
      lastIsMaximized = true;
      // Guardar los bounds normales (antes de maximizar)
      lastBounds = mainWindow.getNormalBounds();
      try {
        const display = screen.getDisplayMatching(lastBounds);
        const area = display.workArea;
        lastIsFullHeight = (Math.abs(lastBounds.y - area.y) <= 1) && (lastBounds.height >= area.height - 1);
      } catch {}
    } catch {}
  });
  mainWindow.on('unmaximize', () => {
    try {
      lastIsMaximized = false;
      lastBounds = mainWindow.getBounds();
      try {
        const display = screen.getDisplayMatching(lastBounds);
        const area = display.workArea;
        lastIsFullHeight = (Math.abs(lastBounds.y - area.y) <= 1) && (lastBounds.height >= area.height - 1);
      } catch {}
    } catch {}
  });
  mainWindow.on('minimize', () => {
    try {
      // Guardar bounds normales justo al minimizar
      const normal = mainWindow.getNormalBounds();
      if (normal && typeof normal.width === 'number') {
        lastBounds = normal;
        try {
          const display = screen.getDisplayMatching(lastBounds);
          const area = display.workArea;
          lastIsFullHeight = (Math.abs(lastBounds.y - area.y) <= 1) && (lastBounds.height >= area.height - 1);
        } catch {}
      }
    } catch {}
  });
}
// Ruta y helpers para settings
function getSettingsPath() {
  try {
    return path.join(app.getPath('userData'), 'settings.json');
  } catch (e) {
    return path.join(__dirname, 'settings.json');
  }
}

function getDefaultSettings() {
  return {
    shortcuts: {
      toggle: 'Control+Shift+Z',
      screenshot: 'Control+Shift+S',
      send: 'Control+Enter',
      mic: 'Control+Shift+M',
      copy: 'Control+Shift+C'
    }
  };
}

// Validación y saneamiento de aceleradores de atajos
const MODIFIER_SET = new Set(['Control','Ctrl','Command','Cmd','CommandOrControl','Alt','AltGr','Option','Shift','Super']);
function isValidAccelerator(accel) {
  if (!accel || typeof accel !== 'string') return false;
  const tokens = accel.split('+').map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return false;
  const hasNonModifier = tokens.some(t => !MODIFIER_SET.has(t));
  return hasNonModifier;
}
function sanitizeShortcuts(sc) {
  const base = (sc && typeof sc === 'object') ? sc : {};
  const defaults = getDefaultSettings().shortcuts;
  const cleaned = {};
  for (const key of Object.keys(defaults)) {
    const val = base[key];
    cleaned[key] = isValidAccelerator(val) ? val : defaults[key];
  }
  return cleaned;
}

function loadSettingsFromDisk() {
  const file = getSettingsPath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw || '{}');
      const merged = { ...getDefaultSettings(), ...parsed, shortcuts: { ...getDefaultSettings().shortcuts, ...(parsed.shortcuts || {}) } };
      const sanitizedShortcuts = sanitizeShortcuts(merged.shortcuts || {});
      const sanitized = { ...merged, shortcuts: sanitizedShortcuts };
      try {
        if (JSON.stringify(sanitized.shortcuts) !== JSON.stringify(merged.shortcuts)) {
          saveSettingsToDisk(sanitized);
        }
      } catch {}
      return sanitized;
    }
  } catch (e) {
    console.error('No se pudo leer settings.json', e);
  }
  const defaults = getDefaultSettings();
  return { ...defaults, shortcuts: sanitizeShortcuts(defaults.shortcuts) };
}

function saveSettingsToDisk(nextSettings) {
  const file = getSettingsPath();
  try {
    fs.writeFileSync(file, JSON.stringify(nextSettings, null, 2), 'utf-8');
    settings = nextSettings;
  } catch (e) {
    console.error('No se pudo guardar settings.json', e);
  }
  return settings;
}

function unregisterShortcuts() {
  try { globalShortcut.unregisterAll(); } catch {}
}

function registerShortcuts() {
  if (!settings) return;
  let sc = settings.shortcuts || {};
  const sanitized = sanitizeShortcuts(sc);
  if (JSON.stringify(sanitized) !== JSON.stringify(sc)) {
    sc = sanitized;
    settings = { ...settings, shortcuts: sc };
    try { saveSettingsToDisk(settings); } catch {}
  }
  unregisterShortcuts();
  // Toggle ventana
  if (sc.toggle) {
    try {
      globalShortcut.register(sc.toggle, () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible() && mainWindow.isFocused()) {
          // Guardar estado antes de minimizar
          try {
            lastIsMaximized = mainWindow.isMaximized();
            if (lastIsMaximized) {
              // Asegurar normal bounds guardados
              lastBounds = mainWindow.getNormalBounds();
            } else {
              lastBounds = mainWindow.getBounds();
            }
            try {
              const display = screen.getDisplayMatching(lastBounds);
              const area = display.workArea;
              lastIsFullHeight = (Math.abs(lastBounds.y - area.y) <= 1) && (lastBounds.height >= area.height - 1);
            } catch {}
          } catch {}
          mainWindow.minimize();
        } else {
          // Si está minimizada, usar restore() para comportarse como el botón de Windows
          try {
            if (mainWindow.isMinimized()) {
              mainWindow.restore();
              mainWindow.focus();
              return;
            }
          } catch {}
          // Restaurar tamaño/posición cuando la ventana está oculta o no minimizada
          try {
            if (lastIsMaximized) {
              mainWindow.show();
              mainWindow.maximize();
              mainWindow.focus();
            } else if (lastBounds) {
              // Si la última vez ocupaba todo el alto del área de trabajo, forzar ese alto
              if (lastIsFullHeight) {
                const display = screen.getDisplayMatching(lastBounds);
                const area = display.workArea;
                const target = { ...lastBounds, y: area.y, height: area.height };
                mainWindow.setBounds(target);
              } else {
                mainWindow.setBounds(lastBounds);
              }
              mainWindow.show();
              mainWindow.focus();
            } else {
              mainWindow.show();
              mainWindow.focus();
            }
          } catch {
            try { mainWindow.show(); mainWindow.focus(); } catch {}
          }
        }
      });
    } catch (e) { console.error('No se pudo registrar atajo toggle', e); }
  }
  // Enviar eventos al renderer para otras acciones
  const registerAction = (accel, action) => {
    if (!accel) return;
    if (!isValidAccelerator(accel)) return;
    try {
      globalShortcut.register(accel, () => {
        if (!mainWindow) return;
        // Para acciones que no requieren UI, no forzar show
        if (action !== 'copy' && action !== 'screenshot' && action !== 'send' && action !== 'mic') {
          try { mainWindow.show(); mainWindow.focus(); } catch {}
        }
        mainWindow.webContents.send('hotkey', { action });
      });
    } catch (e) { console.error('No se pudo registrar atajo', action, e); }
  };
  registerAction(sc.screenshot, 'screenshot');
  registerAction(sc.send, 'send');
  registerAction(sc.mic, 'mic');
  registerAction(sc.copy, 'copy');
}


// Servidor para recibir el token de login
function startAuthCallbackServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/auth/callback')) {
      const url = new URL(req.url, 'http://localhost:5175');
      const token = url.searchParams.get('token');
      if (token) {
        // Envía el token al renderer (frontend)
        if (mainWindow) {
          mainWindow.webContents.send('auth-token', token);
        }
        // Responde al navegador con estilo Skanea (alineado a FrontendWeb)
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Login exitoso | Skanea</title>
  <style>
    :root { --bg:#0d0f14; --border:#222835; --text:#e8e9ed; --muted:#9aa3b2; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Inter, Arial, sans-serif; color:var(--text); min-height:100vh; background: radial-gradient(700px 500px at 20% 20%, rgba(126,231,135,0.12), transparent 60%), radial-gradient(900px 600px at 80% 70%, rgba(105,112,255,0.12), transparent 60%), var(--bg); display:grid; place-items:center; }
    .card { width:min(560px,92vw); background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02)); border:1px solid var(--border); border-radius:16px; padding:28px; box-shadow:0 10px 40px rgba(0,0,0,.35); text-align:center; position:relative; }
    .bg { position:fixed; inset:0; background: radial-gradient(700px 500px at 20% 20%, rgba(126,231,135,0.12), transparent 60%), radial-gradient(900px 600px at 80% 70%, rgba(105,112,255,0.12), transparent 60%); filter:blur(12px); opacity:.55; pointer-events:none; }
    .brand { font-weight:900; letter-spacing:2px; background:linear-gradient(90deg,#7ee787,#a78bfa,#f472b6); -webkit-background-clip:text; background-clip:text; color:transparent; margin-bottom:8px; }
    .title { margin:4px 0 12px; font-size:24px; }
    .subtitle { color:var(--muted); margin-bottom:18px; }
    .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:12px 18px; border-radius:12px; font-weight:600; border:1px solid transparent; cursor:pointer; transition: all .2s ease; }
    .btn-primary { background: linear-gradient(90deg, #7ee787, #b2f5ea); color:#111; border:none; }
  </style>
</head>
<body>
  <div class="bg" aria-hidden="true"></div>
  <div class="card">
    <div class="brand">SKANEA</div>
    <h2 class="title">¡Login exitoso!</h2>
    <p class="subtitle">Tu sesión ha sido iniciada correctamente. Puedes volver a la app y cerrar esta ventana.</p>
  </div>
</body>
</html>`);
      } else {
        res.writeHead(400);
        res.end('Token no recibido');
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(5175, () => {
    console.log('Servidor de callback de auth escuchando en http://localhost:5175/auth/callback');
  });
}

// Handler para abrir URLs en el navegador predeterminado
ipcMain.handle('open-external', (event, url) => {
  shell.openExternal(url);
});

// Handler para abrir archivos locales
ipcMain.handle('open-file', async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'Archivo no encontrado' };
    }
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    console.error('Error al abrir archivo:', error);
    return { success: false, error: error.message };
  }
});

// Handler para guardar archivos (abrir diálogo de guardado)
ipcMain.handle('save-file', async (event, { sourceUrl, defaultName, buffer }) => {
  const { dialog } = require('electron');
  const os = require('os');
  const path = require('path');

  try {
    // Construir la ruta por defecto completa
    const defaultPath = path.join(os.homedir(), 'Downloads', defaultName || 'archivo');

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultPath,
      filters: [
        { name: 'Todos los archivos', extensions: ['*'] }
      ]
    });

    if (!filePath) {
      return { success: false, canceled: true };
    }

    // Si tenemos un buffer directo, usarlo
    if (buffer) {
      fs.writeFileSync(filePath, Buffer.from(buffer));
    }
    // Si no, descargar desde URL
    else if (sourceUrl) {
      const response = await fetch(sourceUrl);
      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    } else {
      throw new Error('Se requiere sourceUrl o buffer');
    }

    return { success: true, path: filePath };
  } catch (error) {
    console.error('[SAVE-FILE] Error al guardar archivo:', error);
    return { success: false, error: error.message };
  }
});

// Cuando la aplicación esté lista
app.whenReady().then(() => {
  startServer().then(() => createWindow());
  startAuthCallbackServer();
  // Cargar settings y registrar atajos
  settings = loadSettingsFromDisk();
  registerShortcuts();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Cerrar la aplicación cuando todas las ventanas estén cerradas
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', async function () {
  if (process.platform !== 'darwin') {
    await stopServer();
    app.quit();
  }
});

// IPC para cargar/guardar settings
ipcMain.handle('load-settings', () => {
  if (!settings) settings = loadSettingsFromDisk();
  return settings;
});

ipcMain.handle('save-settings', (event, next) => {
  const merged = { ...getDefaultSettings(), ...settings, ...(next || {}), shortcuts: { ...getDefaultSettings().shortcuts, ...(settings ? settings.shortcuts : {}), ...((next && next.shortcuts) || {}) } };
  const sanitized = { ...merged, shortcuts: sanitizeShortcuts(merged.shortcuts || {}) };
  saveSettingsToDisk(sanitized);
  registerShortcuts();
  return sanitized;
});
