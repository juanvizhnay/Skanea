import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'no-reply@skanea.com';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:10000';

export async function sendVerificationEmail(email, token) {
  const verifyUrl = `${BACKEND_URL}/api/auth/verify-email?token=${token}`;
  const subject = 'Verifica tu correo para Skanea';
  const html = `
    <h2>¡Bienvenido a Skanea!</h2>
    <p>Para activar tu cuenta, haz clic en el siguiente enlace:</p>
    <a href="${verifyUrl}" target="_blank">Verificar mi correo</a>
    <p>Si no creaste una cuenta, ignora este mensaje.</p>
  `;
  await resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    subject,
    html
  });
}

export async function sendPasswordResetEmail(email, token) {
  const resetUrl = `http://localhost:5174/recuperar2?token=${token}`;
  const subject = 'Recupera tu contraseña en Skanea';
  const html = `
    <h2>Recuperar contraseña</h2>
    <p>Haz clic en el siguiente enlace para restablecer tu contraseña. El enlace es válido por 1 hora:</p>
    <a href="${resetUrl}" target="_blank">Restablecer contraseña</a>
    <p>Si no solicitaste este cambio, ignora este mensaje.</p>
  `;
  await resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    subject,
    html
  });
} 