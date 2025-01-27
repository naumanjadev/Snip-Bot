import { createClient } from 'redis'; // Redis v4+
import { logger } from '../utils/logger';
import { config } from '../config';

// Initialize Redis client with the redisUrl from config
const client = createClient({
  url: config.redisUrl, // e.g., "redis://localhost:6379" or "rediss://..."
});

// Handle Redis client errors
client.on('error', (err) => logger.error('Redis Client Error', err));

// Connect to Redis
client
  .connect()
  .then(() => {
    logger.info('Connected to Redis.');
  })
  .catch((err) => {
    logger.error('Failed to connect to Redis:', err);
  });

/**
 * Retrieves a value from Redis cache.
 * @param key - The cache key.
 * @returns The cached value or null if not found.
 */
export const getCache = async (key: string): Promise<string | null> => {
  try {
    const value = await client.get(key);
    return value;
  } catch (error) {
    logger.error(`Redis GET error for key ${key}:`, error);
    return null;
  }
};

/**
 * Sets a value in Redis cache with an expiration time.
 * @param key - The cache key.
 * @param value - The value to cache.
 * @param ttlSeconds - Time-to-live in seconds.
 */
export const setCache = async (key: string, value: string, ttlSeconds: number): Promise<void> => {
  try {
    await client.set(key, value, { EX: ttlSeconds });
  } catch (error) {
    logger.error(`Redis SET error for key ${key}:`, error);
  }
};
