import type { Config } from 'drizzle-kit'

export default {
  schema: './src/lib/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Migrations need DDL — use DIRECT_URL when available (e.g. Supabase pooler 6543 → direct 5432).
    url:
      process.env.DIRECT_URL ??
      process.env.DATABASE_URL ??
      'postgres://launchai:launchai@localhost:5432/launchai',
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
} satisfies Config
