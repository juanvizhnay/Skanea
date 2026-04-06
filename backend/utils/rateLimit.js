import redisClient from '../config/redis.js';

// Sliding window counter using Redis sorted sets
// key: unique key, nowMs: Date.now(), windowMs: size of window, limit: max events, ttlSeconds: expire key
export async function isRateLimited(key, nowMs, windowMs, limit, ttlSeconds = Math.ceil(windowMs / 1000) * 2) {
  const windowStart = nowMs - windowMs;
  const zkey = `sw:${key}`;
  // Remove old entries
  await redisClient.zRemRangeByScore(zkey, 0, windowStart);
  // Add current event with score nowMs
  await redisClient.zAdd(zkey, [{ score: nowMs, value: `${nowMs}` }]);
  // Count events in window
  const count = await redisClient.zCard(zkey);
  // Set TTL to clean up
  await redisClient.expire(zkey, ttlSeconds);
  return { limited: count > limit, count };
}

// Fixed window with INCR + EXPIRE (useful for simple per-minute limits)
export async function hitFixedWindow(key, windowSeconds, limit) {
  const redisKey = `fw:${key}`;
  const current = await redisClient.incr(redisKey);
  if (current === 1) {
    await redisClient.expire(redisKey, windowSeconds);
  }
  return { limited: current > limit, count: current };
}

// Cooldown bucket: set a TTL under a key to block for a duration
export async function setCooldown(key, seconds) {
  const redisKey = `cd:${key}`;
  await redisClient.setEx(redisKey, seconds, '1');
}

export async function inCooldown(key) {
  const redisKey = `cd:${key}`;
  const ttl = await redisClient.ttl(redisKey);
  return { active: ttl > 0, ttl };
}

// Utility to safely read request IP (trusts Express req.ip)
export function getRequestIp(req) {
  // If behind proxy and trust proxy set, req.ip is fine; else fallback
  return (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '').toString();
}


