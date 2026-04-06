import React from 'react';
import { Navigate } from 'react-router-dom';

function isAuthenticated() {
  // Puedes mejorar esto validando el JWT en el futuro
  return !!localStorage.getItem('skanea_jwt');
}

function isEmailVerified() {
  // Puedes guardar el flag en localStorage al hacer login o decodificar el JWT
  const user = JSON.parse(localStorage.getItem('skanea_user') || '{}');
  return user.email_verificado === true;
}

const ProtectedRoute = ({ children }) => {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  if (!isEmailVerified()) {
    return <Navigate to="/verify-email-pending" replace />;
  }
  return children;
};

export default ProtectedRoute; 