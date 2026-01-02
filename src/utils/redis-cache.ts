import { Redis } from 'ioredis';

interface CustomError extends Error {
  source?: string;
}

const CACHE_EXPIRATION = {
  ONE_HOUR: 60 * 60,
  TWELVE_HOURS: 12 * 60 * 60,
};

const fetch = async <T>(redis: Redis, key: string, fetcher: () => Promise<T>, expires: number) => {
  try {
    const existing = await get<T>(redis, key);
    if (existing !== null) return existing;

    return set(redis, key, fetcher, expires);
  } catch (err) {
    console.error(`Redis fetch error for key ${key}:`, err);
    return fetcher();
  }
};

const get = async <T>(redis: Redis, key: string): Promise<T | null> => {
  try {
    const value = await redis.get(key);
    if (value === null) return null;

    return JSON.parse(value);
  } catch (err) {
    console.error(`Redis get error for key ${key}:`, err);
    return null;
  }
};

const set = async <T>(redis: Redis, key: string, fetcher: () => Promise<T>, expires: number) => {
  try {
    const value = await fetcher();
    await redis.set(key, JSON.stringify(value), 'EX', expires);
    return value;
  } catch (err: any) {
    console.error(`Redis set error for key ${key}:`, err);
    if (err.source === 'fetcher') throw err;
    try {
      return await fetcher();
    } catch (fetchErr: any) {
      console.error(`Fetcher error for key ${key}:`, fetchErr);
      const error: CustomError = new Error(fetchErr.message);
      error.source = 'fetcher';
      throw error;
    }
  }
};

const del = async (redis: Redis, key: string) => {
  try {
    await redis.del(key);
  } catch (err) {
    console.error(`Redis del error for key ${key}:`, err);
  }
};

export default { fetch, set, get, del, CACHE_EXPIRATION };
