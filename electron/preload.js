const { contextBridge, ipcRenderer } = require('electron');

// Exponer APIs seguras al renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Función para recibir el token de autenticación
  onAuthToken: (callback) => ipcRenderer.on('auth-token', (event, token) => callback(token)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  onHotkey: (callback) => ipcRenderer.on('hotkey', (event, data) => callback(data)),
  // Ejemplo de función para mostrar notificaciones del sistema
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', { title, body }),
  // Funciones para manejo de archivos
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  saveFile: (defaultName, buffer) => ipcRenderer.invoke('save-file', { defaultName, buffer })
});
