import React, { useEffect, useState } from 'react';

function VerifyEmail() {
  const [status, setStatus] = useState('pending');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const urlStatus = params.get('status');
    const urlMsg = params.get('msg');

    // Función para actualizar el flag en localStorage
    const setUserVerified = () => {
      const user = JSON.parse(localStorage.getItem('skanea_user') || '{}');
      user.email_verificado = true;
      localStorage.setItem('skanea_user', JSON.stringify(user));
    };

    if (urlStatus === 'success') {
      setStatus('success');
      setMessage('¡Correo verificado y cuenta creada! Ya puedes iniciar sesión.');
      setUserVerified();
      return;
    }
    if (urlStatus === 'error') {
      setStatus('error');
      setMessage(decodeURIComponent(urlMsg || 'Error al verificar el correo.'));
      return;
    }
    if (token) {
      fetch('http://localhost:10000/api/auth/verify-email?token=' + token)
        .then(res => res.json())
        .then(data => {
          if (data.message && data.message.startsWith('¡Correo verificado')) {
            setStatus('success');
            setMessage(data.message);
            setUserVerified();
          } else {
            setStatus('error');
            setMessage(data.message || 'Error al verificar el correo.');
          }
        })
        .catch(() => {
          setStatus('error');
          setMessage('Error de red al verificar el correo.');
        });
      return;
    }
    setStatus('error');
    setMessage('Token de verificación no encontrado.');
  }, []);

  return (
    <section className="auth">
      <div className="auth__bg" aria-hidden="true" />
      <div className="auth__container">
        <div className="auth__card" style={{ textAlign: 'center' }}>
          <div className="auth__brand">SKANEA</div>
          {status === 'pending' && <p>Verificando tu correo...</p>}
          {status === 'success' && <>
            <h2 className="auth__title" style={{ color: 'var(--primary)' }}>¡Correo verificado!</h2>
            <p>{message}</p>
            <a href="/login" className="btn btn-primary" style={{ marginTop: 16, display: 'inline-block' }}>Iniciar sesión</a>
          </>}
          {status === 'error' && <>
            <h2 className="auth__title" style={{ color: '#ff6b6b' }}>Error</h2>
            <p>{message}</p>
            <a href="/login" className="btn btn-ghost" style={{ marginTop: 16, display: 'inline-block' }}>Volver al login</a>
          </>}
        </div>
      </div>
    </section>
  );
}

export default VerifyEmail; 