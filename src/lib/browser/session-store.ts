/**
 * Persistence layer for `browser_sessions`.
 *
 * Stores Playwright storageState per (userId, platform). The storageState
 * is treated like an OAuth refresh token: never logged, never returned in
 * API responses, only readable inside the worker process.
 *
 * Encryption-at-rest is deferred to a follow-up milestone (see
 * docs/BROWSER_AUTONOMY.md §8).
 */
import { and, desc, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '@/lib/db/client'
import { browserSessions } from '@/lib/db/schema'
import type { BrowserSession } from '@/lib/db/schema'
import type { BrowserStorageState } from './types'

export interface UpsertBrowserSessionInput {
  userId: string
  platform: string
  storageState: BrowserStorageState
  accountLabel?: string | null
  runtime: 'local' | 'browserbase'
  fingerprint?: Record<string, unknown>
  expiresAt?: Date | null
}

export async function upsertBrowserSession(
  input: UpsertBrowserSessionInput,
): Promise<string> {
  const existing = await db
    .select({ id: browserSessions.id })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.userId, input.userId),
        eq(browserSessions.platform, input.platform),
      ),
    )
    .orderBy(desc(browserSessions.createdAt))
    .limit(1)

  const now = new Date()

  if (existing[0]) {
    await db
      .update(browserSessions)
      .set({
        storageState: input.storageState,
        accountLabel: input.accountLabel ?? null,
        runtime: input.runtime,
        fingerprint: input.fingerprint ?? null,
        status: 'connected',
        lastUsedAt: now,
        expiresAt: input.expiresAt ?? null,
        updatedAt: now,
      })
      .where(eq(browserSessions.id, existing[0].id))
    return existing[0].id
  }

  const id = nanoid()
  await db.insert(browserSessions).values({
    id,
    userId: input.userId,
    platform: input.platform,
    accountLabel: input.accountLabel ?? null,
    runtime: input.runtime,
    storageState: input.storageState,
    fingerprint: input.fingerprint ?? null,
    status: 'connected',
    lastUsedAt: now,
    expiresAt: input.expiresAt ?? null,
  })
  return id
}

export async function loadBrowserSession(
  userId: string,
  platform: string,
): Promise<BrowserSession | null> {
  const rows = await db
    .select()
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.userId, userId),
        eq(browserSessions.platform, platform),
        eq(browserSessions.status, 'connected'),
      ),
    )
    .orderBy(desc(browserSessions.createdAt))
    .limit(1)
  return rows[0] ?? null
}

export async function markBrowserSessionUsed(id: string): Promise<void> {
  await db
    .update(browserSessions)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(browserSessions.id, id))
}

export async function markBrowserSessionStatus(
  id: string,
  status: 'connected' | 'expired' | 'revoked',
): Promise<void> {
  await db
    .update(browserSessions)
    .set({ status, updatedAt: new Date() })
    .where(eq(browserSessions.id, id))
}
