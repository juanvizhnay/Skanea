import userModel from '../models/user.js';
import { findUserByTelefono } from '../models/user.js';
import pool from '../config/db.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { sendVerificationEmail, sendPasswordResetEmail } from '../config/email.js';
import redisClient from '../config/redis.js';

const JWT_SECRET = process.env.JWT_SECRET || 'skanea_secret';

export const register = async (req, res) => {
  const { email, password, nombre, telefono } = req.body;
  if (!email || !password || !nombre) {
    return res.status(400).json({ message: 'Email, nombre y contraseña son requeridos.' });
  }
  if (email.length > 50) {
    return res.status(400).json({ message: 'El correo no puede superar 50 caracteres.' });
  }
  if (password.length > 40) {
    return res.status(400).json({ message: 'La contraseña no puede superar 40 caracteres.' });
  }
  if (nombre.length > 40) {
    return res.status(400).json({ message: 'El nombre no puede superar 40 caracteres.' });
  }
  if (telefono && telefono.length > 20) {
    return res.status(400).json({ message: 'El teléfono no puede superar 20 caracteres.' });
  }
  // Validación de contraseña
  const lengthOk = password.length >= 8;
  const upperOrSymbol = /[A-Z!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+/.test(password);
  if (!lengthOk || !upperOrSymbol) {
    return res.status(400).json({ message: 'La contraseña debe tener al menos 8 caracteres y contener una mayúscula o símbolo especial.' });
  }
  try {
    const existingUser = await userModel.findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ message: 'Ese correo ya está asociado a una cuenta. Inicia sesión en su caso.' });
    }
    // Regla: 1 teléfono ↔ 1 cuenta (si envían teléfono)
    if (telefono) {
      const phoneOwner = await findUserByTelefono(telefono);
      if (phoneOwner) {
        return res.status(409).json({ message: 'Este teléfono ya está asociado a una cuenta.' });
      }
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    // Generar token seguro y expiración (24 horas)
    const email_verification_token = crypto.randomBytes(32).toString('hex');
    const data = JSON.stringify({ email, hashedPassword, nombre, telefono: telefono || null });
    // Guardar en Redis con TTL de 24h (86400 segundos)
    await redisClient.setEx(`verify:${email_verification_token}`, 86400, data);
    // NO enviar correo aquí
    res.status(201).json({ message: 'Cuenta creada. Debes verificar tu correo desde la página correspondiente.', email, email_verification_token });
  } catch (err) {
    res.status(500).json({ message: 'Error en el registro.', error: err.message });
  }
};

export const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email y contraseña son requeridos.' });
  }
  try {
    // Rate limit: máximo 50 intentos de login por hora por IP
    const loginIpKey = `login_attempts_ip:${req.ip}`;
    const ipAttempts = parseInt(await redisClient.get(loginIpKey) || '0', 10);
    if (ipAttempts >= 50) {
      return res.status(429).json({ message: 'Demasiados intentos de inicio de sesión desde esta IP. Intenta de nuevo en 1 hora.' });
    }
    await redisClient.incr(loginIpKey);
    await redisClient.expire(loginIpKey, 3600); // 1 hora
    // Rate limit: máximo 15 intentos de login por hora por email
    const loginKey = `login_attempts:${email}`;
    const attempts = parseInt(await redisClient.get(loginKey) || '0', 10);
    if (attempts >= 15) {
      return res.status(429).json({ message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 1 hora.' });
    }
    await redisClient.incr(loginKey);
    await redisClient.expire(loginKey, 3600); // 1 hora
    // 1. Buscar en PostgreSQL (usuarios verificados)
    const user = await userModel.findUserByEmail(email);
    if (user) {
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ message: 'Credenciales inválidas.' });
      }
      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1825d' }); // 5 años
      return res.json({ message: 'Login exitoso.', token, user: { id: user.id, email: user.email, nombre: user.nombre, telefono: user.telefono, email_verificado: true } });
    }
    // 2. Buscar en Redis (usuarios no verificados)
    // Buscar todos los tokens de verificación
    const keys = await redisClient.keys('verify:*');
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) {
        const pending = JSON.parse(data);
        if (pending.email === email) {
          const valid = await bcrypt.compare(password, pending.hashedPassword);
          if (!valid) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
          }
          // Usuario no verificado
          const tempUser = { email: pending.email, nombre: pending.nombre, telefono: pending.telefono, email_verificado: false };
          const token = jwt.sign({ email: pending.email }, JWT_SECRET, { expiresIn: '1h' });
          return res.json({ message: 'Login exitoso (no verificado).', token, user: tempUser });
        }
      }
    }
    // Si no se encuentra en ningún lado
    return res.status(401).json({ message: 'Credenciales inválidas.' });
  } catch (err) {
    res.status(500).json({ message: 'Error en el login.', error: err.message });
  }
};

export const verifyEmail = async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.redirect('http://localhost:5174/verify-email?status=error&msg=Token%20de%20verificaci%C3%B3n%20requerido.');
  }
  try {
    const data = await redisClient.get(`verify:${token}`);
    if (!data) {
      return res.redirect('http://localhost:5174/verify-email?status=error&msg=Token%20inv%C3%A1lido%20o%20expirado.');
    }
    const pending = JSON.parse(data);
    const existingUser = await userModel.findUserByEmail(pending.email);
    if (existingUser) {
      await redisClient.del(`verify:${token}`);
      return res.redirect('http://localhost:5174/verify-email?status=error&msg=El%20usuario%20ya%20existe.');
    }
    await userModel.createUser(
      pending.email,
      pending.hashedPassword,
      pending.nombre,
      pending.telefono,
      null,
      null
    );
    await redisClient.del(`verify:${token}`);
    return res.redirect('http://localhost:5174/verify-email?status=success');
  } catch (err) {
    return res.redirect('http://localhost:5174/verify-email?status=error&msg=Error%20al%20verificar%20el%20correo.');
  }
};

export const resendVerification = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email requerido.' });
  try {
    // Buscar en Redis (usuarios no verificados)
    const keys = await redisClient.keys('verify:*');
    let foundKey = null;
    let pending = null;
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed.email === email) {
          foundKey = key;
          pending = parsed;
          break;
        }
      }
    }
    if (!foundKey || !pending) {
      return res.status(404).json({ message: 'Usuario no encontrado.' });
    }
    // Generar nuevo token y actualizar registro en Redis
    const crypto = await import('crypto');
    const newToken = crypto.randomBytes(32).toString('hex');
    const newKey = `verify:${newToken}`;
    await redisClient.setEx(newKey, 86400, JSON.stringify(pending));
    await redisClient.del(foundKey);
    // Enviar correo de verificación
    await sendVerificationEmail(email, newToken);
    res.json({ message: 'Correo de verificación reenviado.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al reenviar el correo.', error: err.message });
  }
};

export const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email requerido.' });
  try {
    const user = await userModel.findUserByEmail(email);
    if (user) {
      // Generar token seguro y expiración (1 hora)
      const crypto = await import('crypto');
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
      await userModel.setPasswordResetToken(user.id, resetToken, expires);
      await sendPasswordResetEmail(email, resetToken);
    }
    // Siempre responder igual, aunque el usuario no exista
    res.json({ message: 'Si el correo está asociado a una cuenta, recibirás un enlace para restablecer tu contraseña.' });
  } catch (err) {
    res.status(500).json({ message: 'Error al procesar la solicitud.', error: err.message });
  }
};

export const resetPassword = async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ message: 'Token y nueva contraseña son requeridos.' });
  }
  if (password.length > 40) {
    return res.status(400).json({ message: 'La contraseña no puede superar 40 caracteres.' });
  }
  // Validación de contraseña
  const lengthOk = password.length >= 8;
  const upperOrSymbol = /[A-Z!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+/.test(password);
  if (!lengthOk || !upperOrSymbol) {
    return res.status(400).json({ message: 'La contraseña debe tener al menos 8 caracteres y contener una mayúscula o símbolo especial.' });
  }
  try {
    const data = await redisClient.get(`reset:${token}`);
    if (!data) {
      return res.status(400).json({ message: 'Token inválido o expirado.' });
    }
    const resetData = JSON.parse(data);
    const hashedPassword = await bcrypt.hash(password, 10);
    await userModel.updatePassword(resetData.email, hashedPassword);
    await redisClient.del(`reset:${token}`);
    res.json({ message: 'Contraseña actualizada exitosamente.' });
  } catch (err) {
    console.error('Error en resetPassword:', err);
    res.status(500).json({ message: 'Error al actualizar la contraseña.', error: err.message });
  }
};
