import React, { useState } from 'react';

function RecuperarContraseña() {
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  
  const validateEmail = (mail) => {
    if (mail.length > 50) return 'El correo no puede superar 50 caracteres.';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) ? '' : 'Formato incorrecto de dirección de correo';
  };

  const handleEmailBlur = () => {
    setEmailTouched(true);
    setEmailError(validateEmail(email));
  };

  const handleEmailChange = (e) => {
    const mail = e.target.value;
    setEmail(mail);
    if (emailTouched) setEmailError(validateEmail(mail));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setEmailTouched(true);
    const err = validateEmail(email);
    setEmailError(err);
    if (err) return;
    setLoading(true);
    setMessage('');
    try {
      const res = await fetch('http://localhost:10000/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      // Siempre mostrar el mismo mensaje, por seguridad
      setMessage('Si el correo está asociado a una cuenta, recibirás un enlace para restablecer tu contraseña.');
    } catch {
      setMessage('Error de red. Intenta de nuevo.');
    }
    setLoading(false);
  };

  return (
    <section className="auth">
      <div className="auth__bg" aria-hidden="true" />
      <div className="auth__container">
        <div className="auth__card">
          <div className="auth__brand">SKANEA</div>
          <h2 className="auth__title">Recuperar contraseña</h2>
          <p className="subtitle" style={{ textAlign: 'center' }}>Ingresa el correo asociado a tu cuenta. Si existe, recibirás un enlace para restablecer tu contraseña.</p>
          <form onSubmit={handleSubmit} className="auth__form">
            <label className="field">
              <span>Correo electrónico</span>
              <input type="email" value={email} onChange={handleEmailChange} onBlur={handleEmailBlur} required maxLength={51} />
            </label>
            {emailTouched && emailError && <div className="form-message error">{emailError}</div>}
            <button type="submit" className="btn btn-primary" disabled={loading || !!emailError || !email}>Enviar correo de recuperación</button>
          </form>
          {message && <p className="form-message" style={{ marginTop: 12 }}>{message}</p>}
        </div>
      </div>
    </section>
  );
}

export default RecuperarContraseña; 