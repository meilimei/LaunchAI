import { Redis, type RedisOptions } from 'ioredis'
import { serverEnv } from '@/lib/env'

/**
 * Single Redis connection, reused for BullMQ + pubsub + rate limit + cache.
 *
 * BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false`
 * for blocking operations.
 *
 * For rediss:// (Upstash, Aiven, etc.) we must pass tls.servername explicitly,
 * otherwise the TLS handshake fails with ECONNRESET on stricter providers.
 */
const globalForRedis = globalThis as unknown as {
  redisConnection: Redis | undefined
}

function buildRedis(): Redis {
  const parsed = new URL(serverEnv.REDIS_URL)
  const isTls = parsed.protocol === 'rediss:'

  const opts: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
    // ipv6 / dual-stack DNS — some providers only resolve via specific family.
    family: 0,
    ...(isTls && { tls: { servername: parsed.hostname } }),
  }

  return new Redis(serverEnv.REDIS_URL, opts)
}

export const redis = globalForRedis.redisConnection ?? buildRedis()

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redisConnection = redis
}

/**
 * Channel naming convention for SSE pubsub:
 *   launchai:job:<jobId>:events
 */
export function jobEventsChannel(jobId: string): string {
  return `launchai:job:${jobId}:events`
}
