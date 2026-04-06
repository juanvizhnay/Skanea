import React from 'react';
import { Link } from 'react-router-dom';

function Landing() {
  return (
    <section className="landing">
      <div className="landing__bg" aria-hidden="true" />
      <div className="topbar">
        <div className="topbar__inner">
          <div className="brand" style={{ marginLeft: 8 }}>SKANEA</div>
          <nav className="menu">
            <a href="#features" className="link">Características</a>
            <a href="#resources" className="link">Recursos</a>
            <a href="#help" className="link">Ayuda</a>
            <a href="#pricing" className="link">Precios</a>
            <Link to="/login" className="btn btn-ghost btn-topbar">Iniciar sesión</Link>
            <Link to="/register" className="btn btn-ghost btn-topbar">Empezar</Link>
          </nav>
        </div>
      </div>
      <div className="landing__container">
        <div className="landing__hero">
          <div className="landing__copy">
            <h1 className="display">Tu copiloto de estudio impulsado por IA</h1>
            <p className="subtitle">Organiza, pregunta y aprende más rápido. Diseño minimal, foco total. Inspirado en la excelencia visual de sitios como Resend.</p>
            <div className="cta-group">
              <Link to="/register" className="btn btn-primary">Empezar</Link>
              <Link to="/login" className="btn btn-ghost">Iniciar sesión</Link>
            </div>
          </div>
          <div className="landing__visual">
            <div className="orb" />
          </div>
        </div>
      </div>
      <div className="bottombar">
        <div className="bottombar__inner">
          <div className="footer__left">© {new Date().getFullYear()} Skanea</div>
          <div className="footer__right">
            <Link to="/terms" className="link">Términos</Link>
            <a className="link" href="#">Privacidad</a>
            <a className="link" href="#">Ayuda</a>
          </div>
        </div>
      </div>
    </section>
  );
}

export default Landing;