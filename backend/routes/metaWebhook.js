import express from 'express';

const router = express.Router();

// Verificación de Webhook (GET)
router.get('/webhook/meta', (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recepción de Webhook (POST)
router.post('/webhook/meta', (req, res) => {
  // Por ahora, solo confirmamos recepción.
  // Futuro: enlazar eventos con usuarios/acciones según phone_number_id/page_id
  console.log('Meta Webhook event:', JSON.stringify(req.body));
  res.sendStatus(200);
});

export default router;


