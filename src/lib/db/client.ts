import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { serverEnv } from '@/lib/env'
import * as schema from './schema'

/**
 * Single Postgres connection pool, reused across the app via globalThis.
 * Avoids connection storms during Next.js dev hot reload.
 */
const globalForPg = globalThis as unknown as {
  pgClient: ReturnType<typeof postgres> | undefined
}

const queryClient =
  globalForPg.pgClient ??
  postgres(serverEnv.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // required for transaction pooler (Supabase) / pgbouncer
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPg.pgClient = queryClient
}

export const db = drizzle(queryClient, { schema, casing: 'snake_case' })
export { schema }
