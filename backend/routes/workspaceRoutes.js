import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  createWorkspace,
  getWorkspaces,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  addCollaborator,
  removeCollaborator,
  getWorkspaceStats,
  searchWorkspaces
} from '../controllers/workspaceController.js';

const router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Rutas principales de workspaces
router.post('/', createWorkspace);
router.get('/', getWorkspaces);
router.get('/search', searchWorkspaces);
router.get('/:id', getWorkspace);
router.put('/:id', updateWorkspace);
router.delete('/:id', deleteWorkspace);

// Rutas de colaboradores
router.post('/:id/collaborators', addCollaborator);
router.delete('/:id/collaborators', removeCollaborator);

// Rutas de estadísticas
router.get('/:id/stats', getWorkspaceStats);

export default router; 