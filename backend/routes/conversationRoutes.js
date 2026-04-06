import express from 'express';
import {
  createConversation,
  getConversations,
  getConversationsByDate,
  getConversation,
  updateConversation,
  moveConversation,
  deleteConversation,
  searchConversations
} from '../controllers/conversationController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Logging de peticiones desactivado por defecto (activar con REQUEST_LOGS=1)
if (process.env.REQUEST_LOGS === '1') {
  router.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// Rutas de conversaciones
router.post('/', createConversation);
router.get('/', getConversations);
router.get('/by-date', getConversationsByDate);
router.get('/search', searchConversations);
router.get('/:id', getConversation);
router.put('/:id', updateConversation);
router.patch('/:id/move', moveConversation);
router.delete('/:id', deleteConversation);

export default router; 