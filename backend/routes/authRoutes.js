import express from 'express';
import { register, login, verifyEmail, resendVerification, forgotPassword, resetPassword } from '../controllers/authController.js';
import signupProtection from '../middleware/signupProtection.js';
import userModel from '../models/user.js';
import authenticateToken from '../middleware/auth.js';

const router = express.Router();

router.post('/register', signupProtection({
  perIpPerDayLimit: 3,
  perDevicePerDayLimit: 3,
  perEmailPerMinuteLimit: 1,
  cooldownSeconds: 15 * 60,
  failuresBeforeCooldown: 5,
  enableMxCheck: true,
  enableDisposableBlock: true,
  captchaProvider: 'turnstile',
  captchaRiskThreshold: 3,
}), register);
router.post('/login', login);
router.get('/verify-email', verifyEmail);
router.post('/resend-verification', resendVerification);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// Endpoint para actualizar el teléfono del usuario logueado
router.put('/telefono', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ message: 'Teléfono requerido.' });
  try {
    const updated = await userModel.updateTelefono(userId, telefono);
    res.json({ message: 'Teléfono actualizado.', user: { id: updated.id, email: updated.email, nombre: updated.nombre, telefono: updated.telefono } });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar el teléfono.', error: err.message });
  }
});

export default router; 