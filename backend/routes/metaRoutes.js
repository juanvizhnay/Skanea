import express from 'express';
import fetch from 'node-fetch';
import pool from '../config/db.js';
import authenticateToken from '../middleware/auth.js';
import { encryptToBase64, decryptFromBase64 } from '../utils/crypto.js';

const router = express.Router();

// Helper: get connector for user/provider
async function getConnector(userId, provider) {
  const res = await pool.query(
    `SELECT * FROM user_connectors WHERE user_id = $1 AND provider = $2 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`,
    [userId, provider]
  );
  return res.rows[0] || null;
}

// WhatsApp: guardar phone_number_id + access token largo
router.post('/whatsapp/save', authenticateToken, async (req, res) => {
  const { phone_number_id, access_token } = req.body;
  if (!phone_number_id || !access_token) {
    return res.status(400).json({ message: 'phone_number_id y access_token son requeridos' });
  }
  const enc = encryptToBase64(access_token);
  const result = await pool.query(
    `INSERT INTO user_connectors (user_id, provider, external_account_id, provider_data, long_lived_token_encrypted, long_lived_token_iv)
     VALUES ($1,'whatsapp',$2,$3,$4,$5)
     ON CONFLICT (user_id, provider, external_account_id) DO UPDATE SET
       provider_data = EXCLUDED.provider_data,
       long_lived_token_encrypted = EXCLUDED.long_lived_token_encrypted,
       long_lived_token_iv = EXCLUDED.long_lived_token_iv,
       updated_at = NOW()
     RETURNING id` ,
    [req.user.id, phone_number_id, { phone_number_id }, enc.ciphertextB64, enc.ivB64]
  );
  res.json({ success: true, connector_id: result.rows[0].id });
});

// WhatsApp: enviar mensaje de texto
router.post('/whatsapp/send', authenticateToken, async (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ message: 'to y text son requeridos' });
  const conn = await getConnector(req.user.id, 'whatsapp');
  if (!conn) return res.status(400).json({ message: 'No hay conector de WhatsApp configurado' });
  const token = decryptFromBase64(conn.long_lived_token_encrypted, conn.long_lived_token_iv);
  const phoneId = conn.external_account_id || (conn.provider_data && conn.provider_data.phone_number_id);
  if (!phoneId) return res.status(400).json({ message: 'phone_number_id no configurado' });
  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(phoneId)}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (!r.ok) return res.status(400).json({ success: false, error: j });
  await pool.query(
    `INSERT INTO audit_logs (user_id, connector_id, provider, action, intent, request, response, status)
     VALUES ($1,$2,'whatsapp','api_call','whatsapp.send',$3,$4,$5)` ,
    [req.user.id, conn.id, payload, j, r.ok ? 'ok' : 'error']
  );
  res.json({ success: true, result: j });
});

// Instagram: guardar ig_business_account_id + long-lived token
router.post('/instagram/save', authenticateToken, async (req, res) => {
  const { ig_business_account_id, access_token } = req.body;
  if (!ig_business_account_id || !access_token) {
    return res.status(400).json({ message: 'ig_business_account_id y access_token son requeridos' });
  }
  const enc = encryptToBase64(access_token);
  const result = await pool.query(
    `INSERT INTO user_connectors (user_id, provider, external_account_id, provider_data, long_lived_token_encrypted, long_lived_token_iv)
     VALUES ($1,'instagram',$2,$3,$4,$5)
     ON CONFLICT (user_id, provider, external_account_id) DO UPDATE SET
       provider_data = EXCLUDED.provider_data,
       long_lived_token_encrypted = EXCLUDED.long_lived_token_encrypted,
       long_lived_token_iv = EXCLUDED.long_lived_token_iv,
       updated_at = NOW()
     RETURNING id`,
    [req.user.id, ig_business_account_id, { ig_business_account_id }, enc.ciphertextB64, enc.ivB64]
  );
  res.json({ success: true, connector_id: result.rows[0].id });
});

// Instagram: publicar imagen con caption (image_url debe ser pública)
router.post('/instagram/post', authenticateToken, async (req, res) => {
  const { image_url, caption } = req.body;
  if (!image_url) return res.status(400).json({ message: 'image_url es requerido' });
  const conn = await getConnector(req.user.id, 'instagram');
  if (!conn) return res.status(400).json({ message: 'No hay conector de Instagram configurado' });
  const token = decryptFromBase64(conn.long_lived_token_encrypted, conn.long_lived_token_iv);
  const igId = conn.external_account_id || (conn.provider_data && conn.provider_data.ig_business_account_id);
  if (!igId) return res.status(400).json({ message: 'ig_business_account_id no configurado' });

  // 1) Crear contenedor
  const containerResp = await fetch(`https://graph.facebook.com/v18.0/${encodeURIComponent(igId)}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url, caption: caption || '', access_token: token })
  });
  const container = await containerResp.json();
  if (!containerResp.ok) return res.status(400).json({ success: false, step: 'container', error: container });

  // 2) Publicar
  const publishResp = await fetch(`https://graph.facebook.com/v18.0/${encodeURIComponent(igId)}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: container.id, access_token: token })
  });
  const publish = await publishResp.json();
  if (!publishResp.ok) return res.status(400).json({ success: false, step: 'publish', error: publish });

  await pool.query(
    `INSERT INTO audit_logs (user_id, connector_id, provider, action, intent, request, response, status)
     VALUES ($1,$2,'instagram','api_call','instagram.post',$3,$4,$5)` ,
    [req.user.id, conn.id, { image_url, caption }, publish, publishResp.ok ? 'ok' : 'error']
  );

  res.json({ success: true, container, publish });
});

export default router;


