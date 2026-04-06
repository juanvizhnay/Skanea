import React, { useState, useEffect } from 'react';

const plans = [
  {
    name: 'Gratis',
    price: '$0',
    features: [
      'Acceso básico al chat',
      'Historial limitado',
      'Sin integración avanzada',
    ],
    value: 'gratis',
  },
  {
    name: 'Basic',
    price: '$4.99/mes',
    features: [
      'Más historial',
      'Respuestas más rápidas',
      'Soporte por email',
    ],
    value: 'basic',
  },
  {
    name: 'Pro',
    price: '$9.99/mes',
    features: [
      'Todo lo de Basic',
      'Integraciones avanzadas',
      'Prioridad en soporte',
    ],
    value: 'pro',
  },
  {
    name: 'Ultimate',
    price: '$19.99/mes',
    features: [
      'Todo lo de Pro',
      'Ilimitado',
      'Acceso anticipado a nuevas funciones',
    ],
    value: 'ultimate',
  },
];

function getToken() {
  return localStorage.getItem('skanea_jwt');
}

function Plans() {
  const [message, setMessage] = useState('');
  const [currentPlan, setCurrentPlan] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Consultar el plan actual del usuario
    const fetchPlan = async () => {
      setLoading(true);
      try {
        const res = await fetch('http://localhost:10000/api/subscriptions/me', {
          headers: {
            'Authorization': 'Bearer ' + getToken(),
          },
        });
        if (res.ok) {
          const data = await res.json();
          setCurrentPlan(data.subscription?.plan || null);
        } else {
          setCurrentPlan(null);
        }
      } catch (err) {
        setCurrentPlan(null);
      }
      setLoading(false);
    };
    fetchPlan();
  }, []);

  const handleSelect = async (plan) => {
    setMessage('');
    setLoading(true);
    try {
      const res = await fetch('http://localhost:10000/api/subscriptions/me', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getToken(),
        },
        body: JSON.stringify({ plan: plan.value, status: 'activa' })
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(`¡Plan ${plan.name} seleccionado!`);
        setCurrentPlan(plan.value);
      } else {
        setMessage(data.message || 'Error al seleccionar el plan.');
      }
    } catch (err) {
      setMessage('Error de red.');
    }
    setLoading(false);
  };

  return (
    <section className="page plans-page">
      <div className="page__container">
        <header className="page__header">
          <h2>Elige tu plan</h2>
          {loading && <p className="muted">Cargando...</p>}
          {currentPlan && !loading && (
            <p className="muted"><b>Tu plan actual:</b> {plans.find(p => p.value === currentPlan)?.name || currentPlan}</p>
          )}
        </header>
        <div className="plans-grid">
          {plans.map(plan => (
            <div className={`plan-card ${currentPlan === plan.value ? 'selected' : ''}`} key={plan.value}>
              <div className="plan-card__header">
                <h3>{plan.name}</h3>
                <div className="plan-price">{plan.price}</div>
              </div>
              <ul className="plan-features">
                {plan.features.map(f => <li key={f}>{f}</li>)}
              </ul>
              <button className="btn btn-primary plan-cta" onClick={() => handleSelect(plan)} disabled={loading || currentPlan === plan.value}>
                {currentPlan === plan.value ? 'Seleccionado' : 'Seleccionar plan'}
              </button>
            </div>
          ))}
        </div>
        {message && <p className="form-message" style={{ marginTop: 12 }}>{message}</p>}
      </div>
    </section>
  );
}

export default Plans; 