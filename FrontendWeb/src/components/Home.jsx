import React from 'react';

function Home() {
  const userRaw = localStorage.getItem('skanea_user');
  const user = userRaw ? JSON.parse(userRaw) : null;
  return (
    <section className="page">
      <div className="page__container">
        <div className="card" style={{ textAlign: 'center' }}>
          <h2 style={{ marginTop: 0 }}>Bienvenido{user?.nombre ? `, ${user.nombre}` : ''}</h2>
          <p className="muted">Este es tu panel de inicio. Desde aquí podrás acceder a tus planes y descargas.</p>
        </div>
      </div>
    </section>
  );
}

export default Home;

