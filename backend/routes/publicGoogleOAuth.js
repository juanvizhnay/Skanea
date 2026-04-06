import express from 'express';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import pool from '../config/db.js';
import { encryptToBase64 } from '../utils/crypto.js';

const router = express.Router();

// Callback público de Google (no requiere JWT porque Google redirige aquí)
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Faltan parámetros');

    // Validar state
    let payload;
    try {
      payload = jwt.verify(state, process.env.STATE_SECRET || process.env.JWT_SECRET);
    } catch (e) {
      return res.status(400).send('State inválido o expirado');
    }
    const userId = payload.uid;

    // Intercambiar code por tokens
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        redirect_uri: process.env.GOOGLE_REDIRECT_URI || '',
        grant_type: 'authorization_code'
      })
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) {
      return res.status(400).send(`Error en token exchange: ${tokenJson.error || 'desconocido'}`);
    }

    const accessToken = tokenJson.access_token;
    const refreshToken = tokenJson.refresh_token;
    const expiresIn = tokenJson.expires_in; // seconds
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    // Obtener perfil de Gmail para email/account id
    const meResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const me = await meResp.json();
    const accountEmail = me.email || null;
    const externalAccountId = me.id || null;

    const enc = encryptToBase64(accessToken);
    const refEnc = refreshToken ? encryptToBase64(refreshToken) : null;

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
       RETURNING id`,
      [
        userId,
        'google',
        externalAccountId,
        accountEmail,
        enc.ciphertextB64,
        enc.ivB64,
        refEnc ? refEnc.ciphertextB64 : null,
        refEnc ? refEnc.ivB64 : null,
        tokenExpiresAt,
        ['gmail.modify', 'calendar.events']
      ]
    );

    // Redirigir a la app (popup) con mensaje simple
    const baseUrl = process.env.BASE_URL || 'http://localhost:5173';
    return res.redirect(`${baseUrl}/?connected=google`);
  } catch (err) {
    console.error('Callback Google error:', err);
    return res.status(500).send('Error interno');
  }
});

export default router;


