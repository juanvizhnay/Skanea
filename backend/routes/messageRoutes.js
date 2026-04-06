import express from 'express';
import {
  createMessage,
  getMessages,
  getMessage,
  updateMessage,
  deleteMessage,
  deleteMessagesAfter,
  markMessageAsRead,
  searchMessages,
  getMessageStats
} from '../controllers/messageController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Rutas de mensajes
router.post('/', createMessage);
router.get('/conversation/:conversationId', getMessages);
router.get('/conversation/:conversationId/stats', getMessageStats);
router.get('/search', searchMessages);
router.get('/:id', getMessage);
router.put('/:id', updateMessage);
router.delete('/:id', deleteMessage);
router.delete('/conversation/:conversationId/after/:messageId', deleteMessagesAfter);
router.patch('/:id/read', markMessageAsRead);

export default router; 