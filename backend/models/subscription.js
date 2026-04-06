import pool from '../config/db.js';

const getSubscriptionByUserId = async (userId) => {
  const result = await pool.query(
    'SELECT * FROM suscripciones WHERE user_id = $1 ORDER BY start_date DESC LIMIT 1',
    [userId]
  );
  return result.rows[0];
};

const createOrUpdateSubscription = async (userId, plan, status, stripeId, startDate, endDate) => {
  // Si ya existe una suscripción activa, la actualiza; si no, la crea
  const existing = await getSubscriptionByUserId(userId);
  if (existing) {
    const result = await pool.query(
      'UPDATE suscripciones SET plan = $1, status = $2, stripe_subscription_id = $3, start_date = $4, end_date = $5 WHERE id = $6 RETURNING *',
      [plan, status, stripeId, startDate, endDate, existing.id]
    );
    return result.rows[0];
  } else {
    const result = await pool.query(
      'INSERT INTO suscripciones (user_id, plan, status, stripe_subscription_id, start_date, end_date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [userId, plan, status, stripeId, startDate, endDate]
    );
    return result.rows[0];
  }
};

export default { getSubscriptionByUserId, createOrUpdateSubscription }; 