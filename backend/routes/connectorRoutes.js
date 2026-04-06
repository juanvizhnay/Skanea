import express from 'express';
import pool from '../config/db.js';
import authenticateToken from '../middleware/auth.js';
import { encryptToBase64 } from '../utils/crypto.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

// Listar conectores del usuario
router.get('/', authenticateToken, async (req, res) => {
  const result = await pool.query(
    `SELECT id, provider, external_account_id, account_email, scopes, token_expires_at, revoked_at, created_at, updated_at
     FROM user_connectors WHERE user_id = $1 ORDER BY provider ASC`,
    [req.user.id]
  );
  res.json({ connectors: result.rows });
});

// Iniciar OAuth de Google: devuelve URL con state (JWT con userId)
router.post('/google/init', authenticateToken, async (req, res) => {
  // Responder con URL de autorización (se implementará en el paso de OAuth)
  const baseUrl = `https://accounts.google.com/o/oauth2/v2/auth`;
  const scopes = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar.events',
    // Scopes de Drive solicitados
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/drive.file'
  ];
  const stateToken = jwt.sign({ uid: req.user.id, ts: Date.now() }, process.env.STATE_SECRET || process.env.JWT_SECRET, { expiresIn: '10m' });
  const url = `${baseUrl}?access_type=offline&include_granted_scopes=true&response_type=code&client_id=${encodeURIComponent(process.env.GOOGLE_CLIENT_ID || '')}&redirect_uri=${encodeURIComponent(process.env.GOOGLE_REDIRECT_URI || '')}&scope=${encodeURIComponent(scopes.join(' '))}&prompt=consent&state=${encodeURIComponent(stateToken)}`;
  res.json({ url });
});

// Desconectar Google (revocar conector a nivel app)
router.delete('/google', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      `UPDATE user_connectors SET revoked_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND provider = 'google' AND revoked_at IS NULL`,
      [req.user.id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('Error revocando Google:', e);
    res.status(500).json({ success: false, message: 'No se pudo desconectar Google' });
  }
});

// Guardar token (callback) — se rellenará cuando implementemos el intercambio de code
router.post('/google/callback/dev', authenticateToken, async (req, res) => {
  // Endpoint temporal para probar cifrado y storage manual
  const { provider, access_token, refresh_token, account_email, external_account_id, token_expires_at } = req.body;
  if (!access_token) return res.status(400).json({ message: 'Falta access_token' });

  const enc = encryptToBase64(access_token);
  const refEnc = refresh_token ? encryptToBase64(refresh_token) : null;

  const result = await pool.query(
    `INSERT INTO user_connectors (user_id, provider, external_account_id, account_email, access_token_encrypted, access_token_iv, refresh_token_encrypted, refresh_token_iv, token_expires_at, scopes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id, provider, external_account_id) DO UPDATE SET
       account_email = EXCLUDED.account_email,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       access_token_iv = EXCLUDED.access_token_iv,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       refresh_token_iv = EXCLUDED.refresh_token_iv,
       token_expires_at = EXCLUDED.token_expires_at,
       updated_at = NOW()
     RETURNING *`,
    [
      req.user.id,
      provider || 'google',
      external_account_id || null,
      account_email || null,
      enc.ciphertextB64,
      enc.ivB64,
      refEnc ? refEnc.ciphertextB64 : null,
      refEnc ? refEnc.ivB64 : null,
      token_expires_at || null,
      ['gmail.modify', 'calendar.events']
    ]
  );

  res.json({ success: true, connector: result.rows[0] });
});

export default router;


