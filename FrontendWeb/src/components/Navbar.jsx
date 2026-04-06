import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import useLogout from '../hooks/useLogout';

function isAuthenticated() {
  return !!localStorage.getItem('skanea_jwt');
}

function Navbar() {
  const logout = useLogout();
  const location = useLocation();
  const navigate = useNavigate();
  if (!isAuthenticated()) return null;
  if (["/login-success", "/login", "/register", "/"].includes(location.pathname)) return null;
  return (
    <nav className="navbar">
      <Link to="/home">Inicio</Link>
      <Link to="/plans">Planes</Link>
      <Link to="/downloads">Descargas</Link>
      <button onClick={() => navigate('/settings')} className="settings-btn" title="Ajustes" style={{ fontSize: 22, marginLeft: 12 }}>
        <span role="img" aria-label="Ajustes">⚙️</span>
      </button>
    </nav>
  );
}

export default Navbar; 