const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

let serverProcess = null;
const PORT = process.env.SKanea_EXTRACT_PORT || process.env.SKANEA_EXTRACT_PORT || '8001';
const HOST = process.env.SKANEA_EXTRACT_HOST || '127.0.0.1';

function getProjectRoot() {
  // __dirname points to .../electron
  return path.resolve(__dirname, '..');
}

function resolvePythonExecutable() {
  if (process.env.SKANEA_PYTHON && process.env.SKANEA_PYTHON.trim()) {
    return process.env.SKANEA_PYTHON;
  }
  const root = getProjectRoot();
  // Prefer venv clásico en la raíz
  const venv312 = path.join(root, '.venv312_extract', 'Scripts', 'python.exe');
  const venv = path.join(root, '.venv', 'Scripts', 'python.exe');
  if (process.platform === 'win32') {
    if (fs.existsSync(venv312)) return venv312;
    if (fs.existsSync(venv)) return venv;
    return 'python';
  }
  const venv312Posix = path.join(root, '.venv312_extract', 'bin', 'python');
  const venvPosix = path.join(root, '.venv', 'bin', 'python');
  if (fs.existsSync(venv312Posix)) return venv312Posix;
  if (fs.existsSync(venvPosix)) return venvPosix;
  return 'python3';
}

async function startServer() {
  if (serverProcess) return;
  const python = resolvePythonExecutable();
  const root = getProjectRoot();
  console.log(`[extract] launching uvicorn with ${python} at http://${HOST}:${PORT}`);
  serverProcess = spawn(python, [
    '-m',
    'uvicorn',
    'services.extract.app:app',
    '--host',
    HOST,
    '--port',
    PORT,
    '--log-level',
    'info'
  ], {
    cwd: root,
    env: { ...process.env }
  });

  serverProcess.stdout.on('data', (d) => process.stdout.write(`[uvicorn] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[uvicorn] ${d}`));
  serverProcess.on('close', (code) => {
    console.log(`uvicorn exited with code ${code}`);
    serverProcess = null;
  });

  // Esperar hasta que /health responda (máximo 30s)
  const baseUrl = `http://${HOST}:${PORT}`;
  const deadline = Date.now() + 30000;
  await new Promise((resolve) => {
    const ping = () => {
      http.get(`${baseUrl}/health`, (res) => {
        const ok = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300;
        res.resume();
        if (ok) return resolve();
        if (Date.now() > deadline) return resolve();
        setTimeout(ping, 500);
      }).on('error', () => {
        if (Date.now() > deadline) return resolve();
        setTimeout(ping, 500);
      });
    };
    ping();
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) return resolve();
    serverProcess.once('exit', () => resolve());
    serverProcess.kill();
    serverProcess = null;
  });
}

module.exports = { startServer, stopServer };


