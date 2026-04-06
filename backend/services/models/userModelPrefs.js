import pool from '../../config/db.js';
import subscriptionModel from '../../models/subscription.js';

export async function resolveUserPlan(userId) {
  if (!userId) return 'free';
  try {
    const s = await subscriptionModel.getSubscriptionByUserId(userId);
    return s?.plan || 'free';
  } catch {
    return 'free';
  }
}

export async function getUserSelectedLocalModel(userId) {
  if (!userId) return null;
  const r = await pool.query(
    'SELECT local_model FROM usuarios WHERE id=$1',
    [userId]
  );
  const row = r.rows?.[0];
  return row?.local_model || null;
}

export async function setUserSelectedLocalModel(userId, model) {
  if (!userId) return null;
  const r = await pool.query(
    'UPDATE usuarios SET local_model=$1 WHERE id=$2 RETURNING local_model',
    [model, userId]
  );
  return r.rows?.[0]?.local_model || null;
}

export async function hasLicenseForLocalModel(userId, model) {
  // Mock license: free for 'llm-mini'; paid models require entry in user_local_licenses
  if (!model || model === 'llm-mini') return true;
  if (!userId) return false;
  const r = await pool.query(
    'SELECT 1 FROM user_local_licenses WHERE user_id=$1 AND model=$2 AND active=TRUE LIMIT 1',
    [userId, model]
  );
  return r.rowCount > 0;
}


