// AnyFix – src/lib/prisma.ts
import { PrismaClient } from '@prisma/client';
import type { Redis as RedisType } from 'ioredis';

declare global { var __prisma: PrismaClient | undefined; }

export const prisma = globalThis.__prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') globalThis.__prisma = prisma;

// ─── Redis (optional) ─────────────────────────────────────
// If REDIS_URL is unset we expose an in-memory shim so the app
// runs without Redis in dev / minimum-viable deployments.

interface MinimalRedis {
  get(key: string): Promise<string | null>;
  set(key: string, val: string): Promise<'OK'>;
  setex(key: string, seconds: number, val: string): Promise<'OK'>;
  del(key: string): Promise<number>;
  ping(): Promise<'PONG'>;
}

function createMemoryRedis(): MinimalRedis {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const isAlive = (entry: { expiresAt?: number }) =>
    !entry.expiresAt || entry.expiresAt > Date.now();

  return {
    async get(key) {
      const e = store.get(key);
      if (!e) return null;
      if (!isAlive(e)) { store.delete(key); return null; }
      return e.value;
    },
    async set(key, value) { store.set(key, { value }); return 'OK'; },
    async setex(key, seconds, value) {
      store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
      return 'OK';
    },
    async del(key) { return store.delete(key) ? 1 : 0; },
    async ping() { return 'PONG'; },
  };
}

let redisInstance: RedisType | MinimalRedis;

if (process.env.REDIS_URL) {
  // Lazy require so apps without ioredis configured don't fail at import time
  const { Redis } = require('ioredis') as typeof import('ioredis');
  const r = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  r.on('error', (err: Error) => console.error('[Redis]', err.message));
  redisInstance = r;
} else {
  console.warn('⚠️  REDIS_URL not set — using in-memory store (single-instance only).');
  redisInstance = createMemoryRedis();
}

export const redis = redisInstance as unknown as RedisType;
