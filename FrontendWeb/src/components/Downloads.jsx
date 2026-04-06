import React from 'react';
import useLogout from '../hooks/useLogout';

function Downloads() {
  const logout = useLogout();
  return (
    <section className="page">
      <div className="page__container">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Descargar Skanea</h2>
          <p className="muted">¡Gracias por elegir Skanea! Descarga la app de escritorio para tu sistema operativo:</p>
          <div className="downloads-list">
            <a href="https://example.com/skanea-win.exe" className="btn btn-primary" download>Descargar para Windows</a>
            <a href="https://example.com/skanea-mac.dmg" className="btn btn-primary" download>Descargar para Mac</a>
            <a href="https://example.com/skanea-linux.AppImage" className="btn btn-primary" download>Descargar para Linux</a>
          </div>
          <p className="muted" style={{ marginTop: '1rem' }}>
            ¿Tienes problemas para instalar? <a href="#">Contáctanos</a> o revisa la <a href="#">ayuda</a>.
          </p>
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button onClick={logout} className="btn btn-ghost">Cerrar sesión</button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default Downloads; 