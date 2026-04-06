import React, { useState, useEffect } from 'react';
import useLogout from '../hooks/useLogout';
import { useNavigate, Link } from 'react-router-dom';

function getToken() {
  return localStorage.getItem('skanea_jwt');
}

function Settings() {
  const logout = useLogout();
  const navigate = useNavigate();
  const [telefono, setTelefono] = useState('');
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [openSections, setOpenSections] = useState({
    cuenta: true,
    seguridad: true,
    notificaciones: false,
    apariencia: false,
    suscripcion: false,
    integraciones: false,
    privacidad: false,
    sesion: false,
  });

  useEffect(() => {
    // Obtener datos del usuario (puedes mejorar esto con un endpoint /me en el futuro)
    // Por ahora, solo desde el JWT o desde el login
    // Aquí simulamos que el backend devuelve el teléfono y nombre
    const fetchUser = async () => {
      setLoading(true);
      try {
        const res = await fetch('http://localhost:10000/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: getToken() }) // Esto es solo un placeholder, idealmente deberías tener un endpoint /me
        });
        // Aquí deberías obtener el usuario real, por ahora lo omitimos
      } catch {}
      setLoading(false);
    };
    // fetchUser(); // Si tienes endpoint /me, descomenta esto
    // Por ahora, solo deja el teléfono vacío
  }, []);

  const handleUpdate = async (e) => {
    e.preventDefault();
    setMessage('');
    setLoading(true);
    try {
      const res = await fetch('http://localhost:10000/api/auth/telefono', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getToken(),
        },
        body: JSON.stringify({ telefono })
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('¡Teléfono actualizado correctamente!');
      } else {
        setMessage(data.message || 'Error al actualizar el teléfono.');
      }
    } catch (err) {
      setMessage('Error de red.');
    }
    setLoading(false);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/login');
  };

  const toggleSection = (key) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <section className="page settings-page">
      <div className="page__container">
        <h2 style={{ margin: '0 0 12px 0' }}>Ajustes</h2>

        <div className="accordion">
          <div className="accordion-item">
            <button className="accordion-header" onClick={() => toggleSection('cuenta')} aria-expanded={openSections.cuenta}>
              <span>Información personal</span>
              <span className="chev">▾</span>
            </button>
            {openSections.cuenta && (
              <div className="accordion-panel">
                <div className="form two-col">
                  <label className="field">
                    <span>Nombre</span>
                    <input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Tu nombre" />
                  </label>
                  <label className="field">
                    <span>Correo</span>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@email.com" />
                  </label>
                </div>
                <div className="hint muted">Edita tu nombre y correo. Los cambios de correo pueden requerir verificación.</div>
              </div>
            )}
          </div>

          <div className="accordion-item">
            <button className="accordion-header" onClick={() => toggleSection('seguridad')} aria-expanded={openSections.seguridad}>
              <span>Seguridad</span>
              <span className="chev">▾</span>
            </button>
            {openSections.seguridad && (
              <div className="accordion-panel">
                <form onSubmit={handleUpdate} className="form">
                  <label className="field">
                    <span>Número de teléfono (2FA)</span>
                    <input type="tel" placeholder="Ej: +34 600 123 456" value={telefono} onChange={e => setTelefono(e.target.value)} required />
                  </label>
                  <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Actualizando...' : 'Guardar teléfono'}</button>
                  {message && <p className="form-message" style={{ marginTop: 8 }}>{message}</p>}
                </form>
                <div className="section-divider" />
                <div className="form two-col">
                  <label className="field">
                    <span>Nueva contraseña</span>
                    <input type="password" placeholder="********" />
                  </label>
                  <label className="field">
                    <span>Repetir contraseña</span>
                    <input type="password" placeholder="********" />
                  </label>
                </div>
                <button className="btn btn-ghost" disabled>Cambiar contraseña (próximamente)</button>
              </div>
            )}
          </div>

          <div className="accordion-item">
            <button className="accordion-header" onClick={() => toggleSection('notificaciones')} aria-expanded={openSections.notificaciones}>
              <span>Notificaciones</span>
              <span className="chev">▾</span>
            </button>
            {openSections.notificaciones && (
              <div className="accordion-panel">
                <div className="switch-row"><label><input type="checkbox" defaultChecked /> Emails de producto</label></div>
                <div className="switch-row"><label><input type="checkbox" /> Actualizaciones y noticias</label></div>
                <div className="switch-row"><label><input type="checkbox" defaultChecked /> Facturación</label></div>
              </div>
            )}
          </div>

          <div className="accordion-item">
            <button className="accordion-header" onClick={() => toggleSection('apariencia')} aria-expanded={openSections.apariencia}>
              <span>Apariencia</span>
              <span className="chev">▾</span>
            </button>
            {openSections.apariencia && (
              <div className="accordion-panel">
                <div className="form two-col">
                  <label className="field">
                    <span>Tema</span>
                    <select>
                      <option>Oscuro (actual)</option>
                      <option>Claro</option>
                      <option>Sistema</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Tamaño de fuente</span>
                    <select>
                      <option>Normal</option>
                      <option>Grande</option>
                      <option>Compacto</option>
                    </select>
                  </label>
                </div>
              </div>
            )}
          </div>

          <div className="accordion-item">
            <button className="accordion-header" onClick={() => toggleSection('suscripcion')} aria-expanded={openSections.suscripcion}>
              <span>Suscripción y facturación</span>
              <span className="chev">▾</span>
            </button>
            {openSections.suscripcion && (
              <div className="accordion-panel">
                <p className="muted">Gestiona tu plan y tus métodos de pago.</p>
                <Link to="/plans" className="btn btn-primary">Administrar plan</Link>
              </div>
            )}
          </div>

          <div className="accordion-item">
            <button className="accordion-header" onClick={() => toggleSection('integraciones')} aria-expanded={openSections.integraciones}>
              <span>Integraciones</span>
              <span className="chev">▾</span>
            </button>
            {openSections.integraciones && (
              <div className="accordion-panel">
                <div className="switch-row"><label><input type="checkbox" /> Google Drive</label></div>
                <div className="switch-row"><label><input type="checkbox" /> OneDrive</label></div>
                <div className="switch-row"><label><input type="checkbox" /> Dropbox</label></div>
              </div>
            )}
          </div>

          <div className="accordion-item">
            <button className="accordion-header" onClick={() => toggleSection('privacidad')} aria-expanded={openSections.privacidad}>
              <span>Sesiones y privacidad</span>
              <span className="chev">▾</span>
            </button>
            {openSections.privacidad && (
              <div className="accordion-panel">
                <button className="btn btn-ghost">Cerrar sesión en todos los dispositivos</button>
                <div className="hint muted">Útil si perdiste acceso a un dispositivo.</div>
                <div className="section-divider" />
                <button className="btn danger" disabled>Eliminar cuenta (próximamente)</button>
              </div>
            )}
          </div>

          <div className="accordion-item">
            <button className="accordion-header" onClick={() => toggleSection('sesion')} aria-expanded={openSections.sesion}>
              <span>Sesión actual</span>
              <span className="chev">▾</span>
            </button>
            {openSections.sesion && (
              <div className="accordion-panel" style={{ display: 'grid', justifyItems: 'center' }}>
                <button onClick={handleLogout} className="btn btn-ghost">Cerrar sesión</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export default Settings; 