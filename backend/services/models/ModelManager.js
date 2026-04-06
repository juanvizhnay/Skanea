import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';

// Simple model manager with versioned folders and sha256 verification

export default class ModelManager {
  constructor({ baseDir = path.join(process.cwd(), 'models'), catalogUrl = process.env.MODEL_CATALOG_URL || '' } = {}) {
    this.baseDir = baseDir;
    this.catalogUrl = catalogUrl;
    this.ensureDir(baseDir);
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  getModelPath(modelKey, version) {
    return path.join(this.baseDir, modelKey, version);
  }

  getActiveSymlink(modelKey) {
    return path.join(this.baseDir, modelKey, 'active');
  }

  async fetchCatalog() {
    if (!this.catalogUrl) throw new Error('MODEL_CATALOG_URL no configurado');
    const r = await fetch(this.catalogUrl, { method: 'GET' });
    if (!r.ok) throw new Error(`Catálogo HTTP ${r.status}`);
    const json = await r.json();
    return json; // { models: [{ key, name, versions: [{ version, size, sha256, url }] }] }
  }

  async downloadWithResume(url, destTmp) {
    const tempPath = destTmp + '.part';
    let start = 0;
    if (fs.existsSync(tempPath)) start = fs.statSync(tempPath).size;
    const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
    const resp = await fetch(url, { headers });
    if (!(resp.ok || resp.status === 206)) throw new Error(`HTTP ${resp.status}`);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tempPath, { flags: start > 0 ? 'a' : 'w' });
      resp.body.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      resp.body.pipe(ws);
    });
    fs.renameSync(tempPath, destTmp);
  }

  async sha256OfFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const rs = fs.createReadStream(filePath);
      rs.on('error', reject);
      hash.once('readable', () => {
        const hex = hash.read().toString('hex');
        resolve(hex);
      });
      rs.on('data', (chunk) => hash.update(chunk));
      rs.on('end', () => hash.end());
    });
  }

  async installModel({ key, version, url, sha256 }) {
    const versionDir = this.getModelPath(key, version);
    this.ensureDir(versionDir);
    const tmpFile = path.join(versionDir, 'model.gguf.tmp');
    await this.downloadWithResume(url, tmpFile);
    const digest = await this.sha256OfFile(tmpFile);
    if ((digest || '').toLowerCase() !== (sha256 || '').toLowerCase()) {
      try { fs.unlinkSync(tmpFile); } catch {}
      throw new Error('Verificación SHA256 falló');
    }
    const finalPath = path.join(versionDir, 'model.gguf');
    fs.renameSync(tmpFile, finalPath);
    return { versionDir, finalPath };
  }

  async activateModel(key, version) {
    const target = this.getModelPath(key, version);
    const active = this.getActiveSymlink(key);
    // Atomic swap: create temp link then rename
    const tmpLink = active + '.tmp';
    try { fs.unlinkSync(tmpLink); } catch {}
    try { fs.unlinkSync(active); } catch {}
    fs.symlinkSync(target, tmpLink, 'junction');
    fs.renameSync(tmpLink, active);
  }

  async cleanupOldVersions(key, keep = 2) {
    const dir = path.join(this.baseDir, key);
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'active')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    const toDelete = entries.slice(0, Math.max(0, entries.length - keep));
    for (const v of toDelete) {
      const p = path.join(dir, v);
      try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
  }
}


