import React, { useState } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Obtener el parámetro redirect de la URL
  const params = new URLSearchParams(location.search);
  const redirect = params.get('redirect');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage(null);
    setLoading(true);
    try {
      const res = await fetch('http://localhost:10000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.ok && data.token) {
        localStorage.setItem('skanea_jwt', data.token);
        localStorage.setItem('skanea_user', JSON.stringify(data.user));
        if (redirect) {
          // Redirigir al callback local con el token
          window.location.href = `${redirect}?token=${data.token}`;
        } else if (data.user.email_verificado) {
          navigate('/home');
        } else {
          navigate('/verify-email-pending');
        }
      } else {
        setMessage(data.message || 'Credenciales incorrectas.');
      }
    } catch (err) {
      setMessage('Error de red.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="auth">
      <div className="auth__bg" aria-hidden="true" />
      <div className="auth__container">
        <div className="auth__card">
          <div className="auth__brand">SKANEA</div>
          <h2 className="auth__title">Iniciar sesión</h2>
          <form onSubmit={handleSubmit} className="auth__form">
            <label className="field">
              <span>Correo electrónico</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </label>
            <label className="field">
              <span>Contraseña</span>
              <div className="password-field">
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required />
                <button
                  type="button"
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  className="toggle-eye"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(v => !v)}
                >
                  <img src="/resourcesWeb/eye.png" alt="" aria-hidden="true" className={showPassword ? 'eye active' : 'eye'} />
                </button>
              </div>
            </label>
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Entrando…' : 'Entrar'}</button>
            {message && <p className="form-message error">{message}</p>}
          </form>
          <div className="auth__links">
            <Link to="/recuperar" className="link">¿Olvidaste tu contraseña?</Link>
            <span>¿No tienes una cuenta? <Link to="/register" className="link">Regístrate</Link></span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default Login; 