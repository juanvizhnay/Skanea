import React, { useState, useRef } from 'react';

function VerifyEmailPending() {
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [sentOnce, setSentOnce] = useState(false);
  const [cooldown, setCooldown] = useState(false); // true si está en cooldown
  const timerRef = useRef(null);
  const user = JSON.parse(localStorage.getItem('skanea_user') || '{}');

  const handleResend = async () => {
    setLoading(true);
    setMessage('');
    try {
      const res = await fetch('http://localhost:10000/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email })
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('Correo de verificación enviado. Podrás solicitar otro en 2 minutos.');
        setSentOnce(true);
        setCooldown(true);
        timerRef.current = setTimeout(() => {
          setCooldown(false);
          setMessage('');
        }, 120000); // 2 minutos
      } else {
        setMessage(data.message || 'Error al enviar el correo.');
      }
    } catch {
      setMessage('Error de red.');
    }
    setLoading(false);
  };

  // Limpiar el timer si el componente se desmonta
  React.useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  return (
    <section className="auth">
      <div className="auth__bg" aria-hidden="true" />
      <div className="auth__container">
        <div className="auth__card" style={{ textAlign: 'center' }}>
          <div className="auth__brand">SKANEA</div>
          <h2 className="auth__title">Verifica tu correo</h2>
          <p>Debes verificar tu correo electrónico para poder usar Skanea.</p>
          <p><b>{user.email}</b></p>
          <button className="btn btn-primary" onClick={handleResend} disabled={loading || cooldown} style={{ marginTop: 8 }}>
            {loading ? 'Enviando...' : sentOnce ? 'Reenviar correo de verificación' : 'Enviar correo de verificación'}
          </button>
          {message && <p className="form-message" style={{ marginTop: 12 }}>{message}</p>}
          <a href="/login" className="btn btn-ghost" style={{ marginTop: 16, display: 'inline-block' }}>Volver al login</a>
        </div>
      </div>
    </section>
  );
}

export default VerifyEmailPending; 