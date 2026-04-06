import React, { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';

function RecuperarContraseñaNueva() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [repeatTouched, setRepeatTouched] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [repeatError, setRepeatError] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const validatePassword = (pwd) => {
    if (pwd.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
    if (pwd.length > 40) return 'La contraseña no puede superar 40 caracteres.';
    if (!/[A-Z!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+/.test(pwd)) return 'Debe contener una mayúscula o símbolo especial.';
    return '';
  };

  const handlePasswordBlur = () => {
    setPasswordTouched(true);
    setPasswordError(validatePassword(password));
    if (repeatTouched) setRepeatError(password !== repeat ? 'Las contraseñas no coinciden.' : '');
  };
  const handleRepeatBlur = () => {
    setRepeatTouched(true);
    setRepeatError(password !== repeat ? 'Las contraseñas no coinciden.' : '');
  };
  const handlePasswordChange = (e) => {
    const pwd = e.target.value;
    setPassword(pwd);
    if (passwordTouched) setPasswordError(validatePassword(pwd));
    if (repeatTouched) setRepeatError(pwd !== repeat ? 'Las contraseñas no coinciden.' : '');
  };
  const handleRepeatChange = (e) => {
    const rep = e.target.value;
    setRepeat(rep);
    if (repeatTouched) setRepeatError(password !== rep ? 'Las contraseñas no coinciden.' : '');
  };
  const isFormValid = () => {
    return password && repeat && !passwordError && !repeatError;
  };
  const handleSubmit = async (e) => {
    e.preventDefault();
    setPasswordTouched(true);
    setRepeatTouched(true);
    setPasswordError(validatePassword(password));
    setRepeatError(password !== repeat ? 'Las contraseñas no coinciden.' : '');
    if (!isFormValid()) return;
    setLoading(true);
    setMessage('');
    try {
      const res = await fetch('http://localhost:10000/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, repeat })
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess(true);
        setMessage('Contraseña actualizada correctamente.');
      } else {
        setMessage(data.message || 'Error al restablecer la contraseña.');
      }
    } catch {
      setMessage('Error de red.');
    }
    setLoading(false);
  };

  if (!token) {
    return (
      <section className="auth">
        <div className="auth__bg" aria-hidden="true" />
        <div className="auth__container">
          <div className="auth__card" style={{ textAlign: 'center' }}>
            <div className="auth__brand">SKANEA</div>
            <h2 className="auth__title">Token inválido</h2>
            <p>El enlace de recuperación no es válido.</p>
            <Link to="/login" className="btn btn-ghost" style={{ marginTop: 12 }}>Volver al login</Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="auth">
      <div className="auth__bg" aria-hidden="true" />
      <div className="auth__container">
        <div className="auth__card" style={{ textAlign: 'center' }}>
          <div className="auth__brand">SKANEA</div>
          <h2 className="auth__title">Restablecer contraseña</h2>
          {success ? (
            <>
              <p className="form-message" style={{ color: 'var(--primary)' }}>{message}</p>
              <Link to="/login" className="btn btn-ghost" style={{ marginTop: 12 }}>Volver al login</Link>
            </>
          ) : (
            <form onSubmit={handleSubmit} className="auth__form">
              <label className="field">
                <span>Nueva contraseña</span>
                <input type="password" value={password} onChange={handlePasswordChange} onBlur={handlePasswordBlur} required maxLength={41} />
              </label>
              {passwordTouched && passwordError && <div className="form-message error">{passwordError}</div>}
              <label className="field">
                <span>Repetir contraseña</span>
                <input type="password" value={repeat} onChange={handleRepeatChange} onBlur={handleRepeatBlur} required maxLength={41} />
              </label>
              {repeatTouched && repeatError && <div className="form-message error">{repeatError}</div>}
              <button type="submit" className="btn btn-primary" disabled={loading || !isFormValid()}>
                {loading ? 'Restableciendo...' : 'Restablecer contraseña'}
              </button>
            </form>
          )}
          {message && !success && <p className="form-message" style={{ marginTop: 12, color: 'orange' }}>{message}</p>}
        </div>
      </div>
    </section>
  );
}

export default RecuperarContraseñaNueva; 