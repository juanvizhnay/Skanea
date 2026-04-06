import { createClient } from 'redis';

const client = createClient({
  url: `redis://default:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
});

client.on('error', (err) => {
  console.error('Redis Client Error:', err);
  // Don't exit the process, just log the error
});

client.on('connect', () => {
  console.log('Redis client connected');
});

client.on('ready', () => {
  console.log('Redis client ready');
});

client.on('end', () => {
  console.log('Redis client disconnected');
});

// Connect to Redis
try {
  await client.connect();
} catch (error) {
  console.error('Failed to connect to Redis:', error);
  // Continue without Redis for now
}

export default client; 