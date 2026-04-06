import express from 'express';
import authenticateToken from '../middleware/auth.js';
import { getMySubscription, createOrUpdateMySubscription } from '../controllers/subscriptionController.js';

const router = express.Router();

// Consultar la suscripción del usuario autenticado
router.get('/me', authenticateToken, getMySubscription);

// Crear o actualizar la suscripción del usuario autenticado
router.post('/me', authenticateToken, createOrUpdateMySubscription);

export default router; 