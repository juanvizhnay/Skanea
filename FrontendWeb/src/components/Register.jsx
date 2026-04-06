import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import Terms from './Terms';

function Register() {
  const [email, setEmail] = useState('');
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [messageType, setMessageType] = useState('info'); // 'info' | 'error' | 'success'
  const [omitTelefono, setOmitTelefono] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [repeatError, setRepeatError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [repeatTouched, setRepeatTouched] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);
  const [nombreError, setNombreError] = useState('');
  const [telefonoError, setTelefonoError] = useState('');
  const [nombreTouched, setNombreTouched] = useState(false);
  const [telefonoTouched, setTelefonoTouched] = useState(false);

  // Turnstile (Cloudflare) integration
  const TURNSTILE_SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY || '';
  const captchaContainerRef = useRef(null);
  const widgetIdRef = useRef(null);
  const pendingCaptchaResolve = useRef(null);
  const [captchaToken, setCaptchaToken] = useState('');

  useEffect(() => {
    if (!TURNSTILE_SITEKEY) return;
    let mounted = true;
    const loadScript = () => new Promise((resolve) => {
      if (window.turnstile) return resolve();
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      document.head.appendChild(s);
    });
    loadScript().then(() => {
      if (!mounted) return;
      try {
        if (!window.turnstile || !captchaContainerRef.current) return;
        widgetIdRef.current = window.turnstile.render(captchaContainerRef.current, {
          sitekey: TURNSTILE_SITEKEY,
          size: 'invisible',
          callback: (token) => {
            setCaptchaToken(token);
            if (pendingCaptchaResolve.current) {
              pendingCaptchaResolve.current(token);
              pendingCaptchaResolve.current = null;
            }
          }
        });
      } catch (err) {
        // ignore
      }
    });
    return () => { mounted = false; };
  }, []);

  const requestCaptchaToken = () => {
    if (!TURNSTILE_SITEKEY || !window.turnstile || widgetIdRef.current == null) return Promise.resolve('');
    if (captchaToken) {
      const t = captchaToken;
      setCaptchaToken('');
      return Promise.resolve(t);
    }
    return new Promise((resolve) => {
      pendingCaptchaResolve.current = resolve;
      try {
        window.turnstile.execute(widgetIdRef.current);
      } catch (err) {
        pendingCaptchaResolve.current = null;
        resolve('');
      }
      setTimeout(() => {
        if (pendingCaptchaResolve.current) {
          pendingCaptchaResolve.current('');
          pendingCaptchaResolve.current = null;
        }
      }, 10000);
    });
  };

  const validateEmail = (mail) => {
    if (mail.length > 50) return 'El correo no puede superar 50 caracteres.';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) ? '' : 'Formato incorrecto de dirección de correo';
  };

  const validatePassword = (pwd) => {
    if (pwd.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
    if (pwd.length > 40) return 'La contraseña no puede superar 40 caracteres.';
    if (!/[A-Z!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]+/.test(pwd)) return 'Debe contener una mayúscula o símbolo especial.';
    return '';
  };

  const validateNombre = (n) => n.length > 40 ? 'El nombre no puede superar 40 caracteres.' : '';
  const validateTelefono = (t) => t && t.length > 20 ? 'El teléfono no puede superar 20 caracteres.' : '';

  const handleNombreBlur = () => {
    setNombreTouched(true);
    setNombreError(validateNombre(nombre));
  };

  const handleTelefonoBlur = () => {
    setTelefonoTouched(true);
    setTelefonoError(validateTelefono(telefono));
  };

  const handleEmailBlur = () => {
    setEmailTouched(true);
    setEmailError(validateEmail(email));
  };

  const handlePasswordBlur = () => {
    setPasswordTouched(true);
    setPasswordError(validatePassword(password));
  };

  const handleRepeatBlur = () => {
    setRepeatTouched(true);
    setRepeatError(password !== repeat ? 'Las contraseñas no coinciden.' : '');
  };

  const handleEmailChange = (e) => {
    const mail = e.target.value;
    setEmail(mail);
    if (emailTouched) setEmailError(validateEmail(mail));
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

  const handleNombreChange = (e) => {
    const n = e.target.value;
    setNombre(n);
    if (nombreTouched) setNombreError(validateNombre(n));
  };

  const handleTelefonoChange = (e) => {
    const t = e.target.value;
    setTelefono(t);
    if (telefonoTouched) setTelefonoError(validateTelefono(t));
  };

  const isFormValid = () => {
    return (
      nombre && email && password && repeat &&
      !nombreError && !emailError && !passwordError && !repeatError && !telefonoError && acceptedTerms
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage(null);
    setMessageType('info');
    if (passwordError || repeatError || emailError) return;
    if (!nombre) {
      setMessage('El nombre es obligatorio.');
      return;
    }
    setLoading(true);
    try {
      // If Turnstile is configured, request a token (may be empty)
      const captcha = await requestCaptchaToken();
      // Lightweight device_id: UA + timezone
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const deviceId = btoa(unescape(encodeURIComponent((navigator.userAgent || '') + '|' + tz))).slice(0, 64);
      const headers = { 'Content-Type': 'application/json', 'x-device-id': deviceId, 'x-timezone': tz };
      if (captcha) headers['x-captcha-token'] = captcha;
      const res = await fetch('http://localhost:10000/api/auth/register', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password, nombre, telefono: omitTelefono ? undefined : telefono })
      });
      const data = await res.json();
      if (res.ok) {
        setMessageType('success');
        setMessage('¡Registro exitoso! Ahora puedes iniciar sesión.');
        if (data.user) {
          localStorage.setItem('skanea_user', JSON.stringify(data.user));
        }
        setEmail(''); setPassword(''); setRepeat(''); setNombre(''); setTelefono(''); setOmitTelefono(false);
      } else {
        setMessageType('error');
        setMessage(data.message || 'Error en el registro.');
      }
    } catch (err) {
      setMessageType('error');
      setMessage('Error de red.');
    }
    setLoading(false);
  };

  return (
    <section className="auth">
      <div className="auth__bg" aria-hidden="true" />
      <div className="auth__container">
        <div className="auth__card">
          <div className="auth__brand">SKANEA</div>
          <h2 className="auth__title">Crear cuenta</h2>
          <form onSubmit={handleSubmit} className="auth__form">
            <label className="field">
              <span>Nombre completo</span>
              <input type="text" value={nombre} onChange={handleNombreChange} onBlur={handleNombreBlur} required maxLength={41} />
            </label>
            {nombreTouched && nombreError && <div className="form-message error">{nombreError}</div>}

            <label className="field">
              <span>Correo</span>
              <input type="email" value={email} onChange={handleEmailChange} onBlur={handleEmailBlur} required maxLength={51} />
            </label>
            {emailTouched && emailError && <div className="form-message error">{emailError}</div>}

            <label className="field">
              <span>Contraseña</span>
              <input type="password" value={password} onChange={handlePasswordChange} onBlur={handlePasswordBlur} required maxLength={41} />
            </label>
            {passwordTouched && passwordError && <div className="form-message error">{passwordError}</div>}

            <label className="field">
              <span>Repetir contraseña</span>
              <input type="password" value={repeat} onChange={handleRepeatChange} onBlur={handleRepeatBlur} required maxLength={41} />
            </label>
            {repeatTouched && repeatError && <div className="form-message error">{repeatError}</div>}

            {!omitTelefono && (
              <>
                <label className="field">
                  <span>Teléfono (opcional)</span>
                  <input type="tel" value={telefono} onChange={handleTelefonoChange} onBlur={handleTelefonoBlur} maxLength={21} />
                </label>
                {telefonoTouched && telefonoError && <div className="form-message error">{telefonoError}</div>}
                <button type="button" className="btn btn-ghost" onClick={() => setOmitTelefono(true)}>Omitir teléfono por ahora</button>
              </>
            )}
            {omitTelefono && (
              <button type="button" className="btn btn-ghost" onClick={() => setOmitTelefono(false)}>Agregar teléfono</button>
            )}

            <div className="terms-row">
              <button type="button" className="link" onClick={() => setShowTerms(true)}>Leer términos de uso</button>
            </div>
            <label className="checkbox-row">
              <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)} />
              <span>Acepto los términos de uso</span>
            </label>
            <button type="submit" className="btn btn-primary" disabled={loading || !isFormValid()}>{loading ? 'Registrando...' : 'Registrarse'}</button>
          </form>
          {message && (
            <p
              className="form-message"
              style={{ marginTop: 8, color: messageType === 'error' ? '#ff4d4f' : messageType === 'success' ? '#2ecc71' : 'inherit' }}
            >
              {message}
            </p>
          )}
          <p style={{ marginTop: '0.75rem', textAlign: 'center', color: 'var(--muted)' }}>
            ¿Ya tienes una cuenta? <Link to="/login" className="link">Inicia sesión aquí</Link>
          </p>
        </div>
      </div>

      {showTerms && (
        <div className="modal" onClick={() => setShowTerms(false)}>
          <div className="modal__card" onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowTerms(false)} className="modal__close">×</button>
            <Terms />
          </div>
        </div>
      )}
    </section>
  );
}

export default Register; 