import express from 'express';
import catalogRoutes from '../services/models/catalogRoutes.js';

const router = express.Router();

router.use('/models', catalogRoutes);

export default router;


