import express from 'express';
import ModelManager from './ModelManager.js';
import authenticateToken from '../../middleware/auth.js';
import { setUserSelectedLocalModel, hasLicenseForLocalModel } from './userModelPrefs.js';

const router = express.Router();
const manager = new ModelManager({});
const FREE_LOCAL_MODELS = new Set(['llm-mini', 'llm-lite', 'mistral:instruct', 'llama2:7b-chat']);

router.get('/catalog', async (req, res) => {
  try {
    const catalog = await manager.fetchCatalog();
    res.json(catalog);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/download', authenticateToken, async (req, res) => {
  try {
    const { key, version, url, sha256 } = req.body || {};
    if (!key || !version || !url || !sha256) return res.status(400).json({ error: 'Faltan campos' });
    const r = await manager.installModel({ key, version, url, sha256 });
    await manager.activateModel(key, version);
    await manager.cleanupOldVersions(key);
    res.json({ ok: true, installedAt: r.finalPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/select', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { model } = req.body || {};
    if (!model) return res.status(400).json({ error: 'Falta model' });
    // Permitir forzar cloud
    if (String(model).toLowerCase().startsWith('cloud')) {
      await setUserSelectedLocalModel(userId, '__cloud__');
      return res.json({ ok: true, selected: 'cloud:o3' });
    }
    // Check license if not free model (whitelist de modelos locales gratuitos)
    if (!FREE_LOCAL_MODELS.has(model)) {
      const ok = await hasLicenseForLocalModel(userId, model);
      if (!ok) return res.status(403).json({ error: 'Sin licencia para este modelo' });
    }
    await setUserSelectedLocalModel(userId, model);
    res.json({ ok: true, selected: model });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/selection', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id;
    const current = await (async () => {
      try { return await (await import('./userModelPrefs.js')).getUserSelectedLocalModel(userId); } catch { return null; }
    })();
    const selected = current === '__cloud__' ? 'cloud:o3' : (current || null);
    res.json({ selected, available: ['cloud:o3', 'mistral:instruct', 'llm-lite'] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;


