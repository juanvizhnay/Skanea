import crypto from 'crypto';
import redisClient from '../config/redis.js';
import { isRateLimited, hitFixedWindow, setCooldown, inCooldown, getRequestIp } from '../utils/rateLimit.js';
import { getEmailDomain, isDisposableDomain, hasValidMx } from '../utils/emailRisk.js';
import userModel from '../models/user.js';

// Lightweight device fingerprint based on headers
function buildDeviceId(req) {
  // Prefer explicit header
  const provided = (req.headers['x-device-id'] || '').toString();
  if (provided) return provided;
  const userAgent = (req.headers['user-agent'] || '').toString();
  const acceptLang = (req.headers['accept-language'] || '').toString();
  const tz = (req.headers['x-timezone'] || '').toString();
  const raw = `${userAgent}|${acceptLang}|${tz}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Optional: simple risk score that can trigger CAPTCHA
async function computeRiskSignals({ ip, emailDomain, deviceId }) {
  let score = 0;
  // Disposable domain heavy penalty
  if (isDisposableDomain(emailDomain)) score += 3;
  // Basic public IP patterns (very naive placeholder)
  if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) {
    // private IP seen from server means something off, but in proxies it's fine
    score += 1;
  }
  // Past cooldowns increase risk
  const cool = await inCooldown(`signup:${ip}`);
  if (cool.active) score += 2;
  const coolDev = await inCooldown(`signupDevice:${deviceId}`);
  if (coolDev.active) score += 2;
  return score;
}

export default function signupProtection(options = {}) {
  const {
    perIpPerDayLimit = 3,              // 3 cuentas/IP por 24h
    perDevicePerDayLimit = 3,          // 3 cuentas/device por 24h
    perEmailPerMinuteLimit = 1,        // 1 intento/min
    cooldownSeconds = 15 * 60,         // 15 min cooldown
    failuresBeforeCooldown = 5,        // N fallos antes de cooldown
    enableMxCheck = true,
    enableDisposableBlock = true,
    captchaProvider = 'turnstile',     // 'turnstile' | 'recaptcha' | 'none'
    captchaRiskThreshold = 3,          // activar captcha si score >= 3
  } = options;

  return async function(req, res, next) {
    try {
      const nowMs = Date.now();
      const ip = getRequestIp(req);
      const deviceId = buildDeviceId(req);
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ message: 'Email requerido.' });
      const emailDomain = getEmailDomain(email);

      // Cooldown checks first
      const cdIp = await inCooldown(`signup:${ip}`);
      if (cdIp.active) {
        return res.status(429).json({ message: `Demasiadas solicitudes desde esta IP. Intenta en ${cdIp.ttl}s.` });
      }
      const cdDev = await inCooldown(`signupDevice:${deviceId}`);
      if (cdDev.active) {
        return res.status(429).json({ message: `Demasiadas solicitudes desde este dispositivo. Intenta en ${cdDev.ttl}s.` });
      }

      // Sliding window: per IP per 24h
      const ipWindow = await isRateLimited(`signup:ip:${ip}`, nowMs, 24 * 60 * 60 * 1000, perIpPerDayLimit);
      if (ipWindow.limited) {
        await setCooldown(`signup:${ip}`, cooldownSeconds);
        return res.status(429).json({ message: 'Límite de creación de cuentas por IP excedido.' });
      }

      // Sliding window: per device per 24h
      const devWindow = await isRateLimited(`signup:dev:${deviceId}`, nowMs, 24 * 60 * 60 * 1000, perDevicePerDayLimit);
      if (devWindow.limited) {
        await setCooldown(`signupDevice:${deviceId}`, cooldownSeconds);
        return res.status(429).json({ message: 'Límite de creación de cuentas por dispositivo excedido.' });
      }

      // Fixed window: per email per minute, pero NO aplicar si el email ya existe en DB
      // para que en ese caso prevalezca el 409 "El usuario ya existe" del controlador.
      const existing = await userModel.findUserByEmail(email).catch(() => null);
      if (!existing) {
        const emailMinute = await hitFixedWindow(`signup:emailMin:${email}`, 60, perEmailPerMinuteLimit);
        if (emailMinute.limited) {
          return res.status(429).json({ message: 'Demasiados intentos para este email. Intenta en 1 minuto.' });
        }
      }

      // Disposable domain block
      if (enableDisposableBlock && isDisposableDomain(emailDomain)) {
        return res.status(400).json({ message: 'No se permiten dominios de correo desechables.' });
      }

      // MX validation
      if (enableMxCheck) {
        const mxOk = await hasValidMx(emailDomain);
        if (!mxOk) {
          return res.status(400).json({ message: 'El dominio de correo no tiene registros MX válidos.' });
        }
      }

      // Risk score and optional CAPTCHA
      const risk = await computeRiskSignals({ ip, emailDomain, deviceId });
      if (captchaProvider !== 'none' && risk >= captchaRiskThreshold) {
        const token = (req.headers['x-captcha-token'] || req.body?.captchaToken || '').toString();
        if (!token) {
          return res.status(403).json({ message: 'Se requiere CAPTCHA.' });
        }
        const ok = await verifyCaptcha(token, captchaProvider, req.headers['cf-turnstile-secret'], req.headers['recaptcha-secret']);
        if (!ok) {
          // Count failure and possibly set cooldown
          const failCount = await redisClient.incr(`signup:fail:${ip}`);
          await redisClient.expire(`signup:fail:${ip}`, 60 * 60);
          if (failCount >= failuresBeforeCooldown) {
            await setCooldown(`signup:${ip}`, cooldownSeconds);
          }
          return res.status(403).json({ message: 'CAPTCHA inválido.' });
        }
      }

      // Pass-through with annotated deviceId for downstream usage
      req.signupProtection = { ip, deviceId, emailDomain };
      next();
    } catch (err) {
      console.error('signupProtection error:', err);
      return res.status(500).json({ message: 'Error en protección de registro.' });
    }
  };
}

async function verifyCaptcha(token, provider, turnstileSecretHeader, recaptchaSecretHeader) {
  try {
    if (provider === 'turnstile') {
      const secret = process.env.TURNSTILE_SECRET || (turnstileSecretHeader || '').toString();
      if (!secret) return false;
      const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token })
      });
      const data = await resp.json();
      return !!data.success;
    }
    if (provider === 'recaptcha') {
      const secret = process.env.RECAPTCHA_SECRET || (recaptchaSecretHeader || '').toString();
      if (!secret) return false;
      const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token })
      });
      const data = await resp.json();
      // For v3, you might check score as well
      return !!data.success;
    }
    return false;
  } catch {
    return false;
  }
}


