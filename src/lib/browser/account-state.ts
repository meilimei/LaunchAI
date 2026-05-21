/**
 * Account-state store — reads / writes `browser_sessions.account_state`.
 *
 * The state object is a small JSONB blob per (userId, platform) that the
 * warm-up planner and platform adapters use to coordinate over time.
 * Schema: see `AccountState` in src/lib/platforms/types.ts and
 * docs/ACCOUNT_GROOMING.md §3.
 *
 * All updates are read-modify-write under a single transaction. The
 * caller passes a transformer; the store handles persistence.
 */
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { browserSessions } from '@/lib/db/schema'
import type { AccountState, SubredditState } from '@/lib/platforms/types'

/** Normalize sub name for state-map keys: 'r/ChatGPT' → 'chatgpt'. */
export function normalizeSubreddit(input: string): string {
  return input.replace(/^\/?r\//i, '').trim().toLowerCase()
}

const MAX_RECENT_TIMESTAMPS = 30

export async function loadAccountState(
  userId: string,
  platform: string,
): Promise<AccountState | null> {
  const rows = await db
    .select({ id: browserSessions.id, accountState: browserSessions.accountState })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.userId, userId),
        eq(browserSessions.platform, platform),
      ),
    )
    .orderBy(desc(browserSessions.createdAt))
    .limit(1)
  if (!rows[0]) return null
  return (rows[0].accountState as AccountState | null) ?? null
}

export async function updateAccountState(
  userId: string,
  platform: string,
  patch: (current: AccountState) => AccountState,
): Promise<AccountState | null> {
  const rows = await db
    .select({ id: browserSessions.id, accountState: browserSessions.accountState })
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.userId, userId),
        eq(browserSessions.platform, platform),
      ),
    )
    .orderBy(desc(browserSessions.createdAt))
    .limit(1)
  if (!rows[0]) return null

  const current = (rows[0].accountState as AccountState | null) ?? {}
  const next = patch({ ...current })

  // Bound the recentActionTimestamps list.
  if (next.warmup?.recentActionTimestamps) {
    next.warmup.recentActionTimestamps = next.warmup.recentActionTimestamps
      .slice(-MAX_RECENT_TIMESTAMPS)
  }

  await db
    .update(browserSessions)
    .set({ accountState: next, updatedAt: new Date() })
    .where(eq(browserSessions.id, rows[0].id))

  return next
}

/**
 * Convenience: append a timestamp + bump a per-action counter.
 * Used after every successful grooming action.
 */
export async function recordGroomingAction(
  userId: string,
  platform: string,
  kind: 'follow' | 'upvote' | 'engage',
): Promise<AccountState | null> {
  return updateAccountState(userId, platform, (state) => {
    const w = { ...(state.warmup ?? {}) }
    if (kind === 'follow') w.followsCompleted = (w.followsCompleted ?? 0) + 1
    if (kind === 'upvote') w.upvotesCompleted = (w.upvotesCompleted ?? 0) + 1
    if (kind === 'engage') w.engagementsCompleted = (w.engagementsCompleted ?? 0) + 1
    w.recentActionTimestamps = [
      ...(w.recentActionTimestamps ?? []),
      new Date().toISOString(),
    ]
    return { ...state, warmup: w }
  })
}

/**
 * Convenience: persist a cooldown verdict from the agent.
 */
export async function recordCooldown(
  userId: string,
  platform: string,
  cooldownUntil: Date,
  reason: NonNullable<AccountState['cooldownReason']>,
  evidence?: string,
): Promise<AccountState | null> {
  return updateAccountState(userId, platform, (state) => ({
    ...state,
    cooldownUntil: cooldownUntil.toISOString(),
    cooldownReason: reason,
    cooldownEvidence: evidence,
  }))
}

/**
 * Mark a profile field as set.
 */
export async function recordProfileField(
  userId: string,
  platform: string,
  field: keyof NonNullable<AccountState['profile']>,
): Promise<AccountState | null> {
  return updateAccountState(userId, platform, (state) => ({
    ...state,
    profile: { ...(state.profile ?? {}), [field]: true },
  }))
}

/**
 * Whether the account is currently in cooldown for write actions.
 */
export function isInCooldown(state: AccountState | null | undefined): boolean {
  if (!state?.cooldownUntil) return false
  return new Date(state.cooldownUntil).getTime() > Date.now()
}

// ────────────────────────────────────────────────────────────────────────────
// Subreddit-level state — used by the Reddit adapter only.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Whether this specific subreddit is in cooldown. Independent of the
 * platform-wide cooldown — a sub-rules block does NOT lock other subs.
 */
export function isSubredditInCooldown(
  state: AccountState | null | undefined,
  subreddit: string,
): boolean {
  if (!state?.subredditState) return false
  const slice = state.subredditState[normalizeSubreddit(subreddit)]
  if (!slice?.cooldownUntil) return false
  return new Date(slice.cooldownUntil).getTime() > Date.now()
}

/**
 * Persist a per-subreddit cooldown — typically when the agent finishes with
 * `blocked_reason: 'subreddit_rules'` after reading the sub's rules.
 */
export async function recordSubredditCooldown(
  userId: string,
  platform: string,
  subreddit: string,
  cooldownUntil: Date,
  reason: NonNullable<SubredditState['cooldownReason']>,
  evidence?: string,
): Promise<AccountState | null> {
  const key = normalizeSubreddit(subreddit)
  return updateAccountState(userId, platform, (state) => {
    const map = { ...(state.subredditState ?? {}) }
    map[key] = {
      ...(map[key] ?? {}),
      cooldownUntil: cooldownUntil.toISOString(),
      cooldownReason: reason,
      cooldownEvidence: evidence,
    }
    return { ...state, subredditState: map }
  })
}

/**
 * Bump the per-sub timestamp after a successful post / comment. Lets the
 * planner enforce per-sub posting frequency limits.
 */
export async function recordSubredditAction(
  userId: string,
  platform: string,
  subreddit: string,
  kind: 'post' | 'comment',
): Promise<AccountState | null> {
  const key = normalizeSubreddit(subreddit)
  const nowIso = new Date().toISOString()
  return updateAccountState(userId, platform, (state) => {
    const map = { ...(state.subredditState ?? {}) }
    const slice = { ...(map[key] ?? {}) }
    if (kind === 'post') slice.lastPostAt = nowIso
    if (kind === 'comment') slice.lastCommentAt = nowIso
    map[key] = slice
    return { ...state, subredditState: map }
  })
}

/**
 * Cache the rules summary the agent extracted, so the planner can skip
 * re-reading sidebars next time it considers this sub.
 */
export async function recordSubredditRules(
  userId: string,
  platform: string,
  subreddit: string,
  rulesSummary: string,
): Promise<AccountState | null> {
  const key = normalizeSubreddit(subreddit)
  return updateAccountState(userId, platform, (state) => {
    const map = { ...(state.subredditState ?? {}) }
    map[key] = {
      ...(map[key] ?? {}),
      rulesVerifiedAt: new Date().toISOString(),
      rulesSummary: rulesSummary.slice(0, 2000),
    }
    return { ...state, subredditState: map }
  })
}

/**
 * Derive the lifecycle stage from raw state. Pure function.
 *
 * See docs/ACCOUNT_GROOMING.md §1 for the model.
 */
export function deriveStage(
  state: AccountState | null | undefined,
): NonNullable<AccountState['stage']> {
  if (!state) return 'fresh'
  if (state.cooldownReason === 'verify_email' || state.cooldownReason === 'manual_review') {
    return 'paused'
  }
  if (isInCooldown(state)) return 'paused'

  const profileComplete =
    state.profile?.bioSet && state.profile?.avatarSet && state.profile?.websiteSet
  const minWarmup =
    (state.warmup?.followsCompleted ?? 0) >= 10 &&
    (state.warmup?.upvotesCompleted ?? 0) >= 15

  if (!profileComplete) return 'fresh'
  if (!minWarmup) return 'warming'
  // Once a real post has been published the supervisor will flip to 'active'.
  return 'posting_ready'
}
