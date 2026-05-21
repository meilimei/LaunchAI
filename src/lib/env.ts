import { z } from 'zod'

/**
 * Treat empty strings (e.g. `OPENAI_API_KEY=`) as missing so that
 * `.optional()` actually skips them. Without this, `min(1)` fails on `""`
 * and the worker crashes on startup. Trims whitespace too.
 */
const optionalNonEmpty = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
)

/**
 * Server-side environment variable schema.
 * Validates at startup. Failing fast > runtime surprises.
 */
const ServerEnv = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  // For migrations (drizzle-kit). Falls back to DATABASE_URL if not set.
  // On Supabase, this should point to the direct connection (port 5432),
  // because the transaction pooler (6543) does not support DDL.
  DIRECT_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().optional(),
  ),
  REDIS_URL: z.string().url(),

  OPENAI_API_KEY: optionalNonEmpty,
  ANTHROPIC_API_KEY: optionalNonEmpty,
  DEEPSEEK_API_KEY: optionalNonEmpty,

  BROWSERBASE_API_KEY: z.string().optional(),
  BROWSERBASE_PROJECT_ID: z.string().optional(),

  CLERK_SECRET_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),

  LLM_ANALYST_MODEL: z.string().optional(),
  LLM_WRITER_MODEL: z.string().optional(),
  LLM_CRITIC_MODEL: z.string().optional(),
})

const PublicEnv = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),
})

function loadServerEnv() {
  const parsed = ServerEnv.safeParse(process.env)
  if (!parsed.success) {
    console.error('❌ Invalid server env:', parsed.error.flatten().fieldErrors)
    throw new Error('Invalid server environment variables')
  }
  return parsed.data
}

function loadPublicEnv() {
  const parsed = PublicEnv.safeParse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  })
  if (!parsed.success) {
    console.error('❌ Invalid public env:', parsed.error.flatten().fieldErrors)
    throw new Error('Invalid public environment variables')
  }
  return parsed.data
}

/**
 * Server-only env. Importing this from client code will fail at runtime.
 */
export const serverEnv =
  typeof window === 'undefined' ? loadServerEnv() : ({} as ReturnType<typeof loadServerEnv>)

export const publicEnv = loadPublicEnv()
