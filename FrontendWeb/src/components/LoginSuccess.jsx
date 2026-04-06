import React from 'react';

function LoginSuccess() {
  return (
    <div className="auth">
      <div className="auth__bg" />
      <div className="auth__container">
        <div className="auth__card" style={{ textAlign: 'center' }}>
          <div className="auth__brand">SKANEA</div>
          <h2 className="auth__title">¡Login exitoso!</h2>
          <p className="muted" style={{ marginTop: 6 }}>
            Tu sesión ha sido iniciada correctamente.
            <br />Puedes volver a la app y cerrar esta ventana.
          </p>
          <div style={{ marginTop: 18 }}>
            <button className="btn btn-primary" onClick={() => window.close()}>Cerrar ventana</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoginSuccess;