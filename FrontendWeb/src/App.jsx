import React from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import Landing from './components/Landing.jsx';
import Login from './components/Login.jsx';
import Register from './components/Register.jsx';
import Terms from './components/Terms.jsx';
import Plans from './components/Plans.jsx';
import Downloads from './components/Downloads.jsx';
import LoginSuccess from './components/LoginSuccess.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Navbar from './components/Navbar.jsx';
import Settings from './components/Settings.jsx';
import VerifyEmail from './components/VerifyEmail.jsx';
import VerifyEmailPending from './components/VerifyEmailPending.jsx';
import RecuperarContraseña from './components/RecuperarContraseña.jsx';
import RecuperarContraseñaNueva from './components/RecuperarContraseñaNueva.jsx';
import Home from './components/Home.jsx';

const noNavbarRoutes = [
  '/login',
  '/register',
  '/recuperar',
  '/recuperar2',
  '/verify-email',
  '/verify-email-pending'
];

function App() {
  const location = useLocation();
  const hideNavbar = noNavbarRoutes.some(route => location.pathname.startsWith(route));
  return (
    <>
      {!hideNavbar && <Navbar />}
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/verify-email-pending" element={<VerifyEmailPending />} />
        <Route path="/recuperar" element={<RecuperarContraseña />} />
        <Route path="/recuperar2" element={<RecuperarContraseñaNueva />} />
        <Route path="/plans" element={
          <ProtectedRoute>
            <Plans />
          </ProtectedRoute>
        } />
        <Route path="/downloads" element={
          <ProtectedRoute>
            <Downloads />
          </ProtectedRoute>
        } />
        <Route path="/home" element={
          <ProtectedRoute>
            <Home />
          </ProtectedRoute>
        } />
        <Route path="/login-success" element={<LoginSuccess />} />
        <Route path="/settings" element={
          <ProtectedRoute>
            <Settings />
          </ProtectedRoute>
        } />
      </Routes>
    </>
  );
}

export default App; 