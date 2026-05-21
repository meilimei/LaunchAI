/**
 * Reddit profile probe — read-only karma / age / verification probe.
 *
 * Why a probe exists:
 *   Before we attempt any mutating action (post, comment, vote, follow) on
 *   Reddit, we need to know if the account is even *capable* of the action
 *   succeeding. A brand-new account with 0 karma will have its first post
 *   silently shadow-removed by Reddit's spam filter, regardless of how well
 *   the agent fills the form. That's the failure mode we saw in practice:
 *   Then-Armadillo1412 (0 karma, 2-day-old account) could never have landed
 *   a post in r/ChatGPT no matter what the agent did.
 *
 *   Running this probe before a write action lets us either (a) refuse the
 *   action up-front with blocked_reason='karma_threshold' so the user sees
 *   a useful diagnostic, or (b) enqueue warm-up actions first.
 *
 * Why HTTP, not browser:
 *   Reddit exposes a public JSON endpoint `/user/<name>/about.json` that
 *   returns the full profile without authentication. Hitting it is <1s +
 *   free (no LLM). Browser-probing would cost ~$0.01 and 10s per check.
 *   The endpoint is ToS-compliant — same data as the public profile page.
 *
 * Caching:
 *   The adapter calls `loadRedditProfileCached`, which skips the HTTP hit
 *   if `accountState.metrics.lastProbedAt` is less than PROBE_TTL_MS old.
 *   Karma changes slowly; 6h freshness is plenty.
 */
import { loadAccountState, updateAccountState } from '@/lib/browser/account-state'
import { loadBrowserSession } from '@/lib/browser/session-store'
import type { BrowserStorageState } from '@/lib/browser/types'
import type { AccountState } from '@/lib/platforms/types'

/** Maximum age of a cached probe before we re-fetch. Karma moves slowly. */
const PROBE_TTL_MS = 6 * 60 * 60 * 1000

/** User-Agent string Reddit's API expects — blank or generic UAs get 429'd. */
const USER_AGENT = 'LaunchAI/0.1 (+https://github.com/LaunchAI) account-probe'

export interface RedditProfile {
  username: string
  /** Total karma (link + comment), the number most rule-sets care about. */
  totalKarma: number
  linkKarma: number
  commentKarma: number
  /** Account age in whole days at probe time. */
  accountAgeDays: number
  hasVerifiedEmail: boolean
  hasAvatar: boolean
  hasBio: boolean
}

/**
 * Public about-JSON response shape — only the fields we read. Reddit
 * returns much more; we intentionally narrow to the columns we care about
 * so schema drift elsewhere doesn't break us.
 */
interface AboutJsonResponse {
  kind: string
  data: {
    name?: string
    link_karma?: number
    comment_karma?: number
    total_karma?: number
    created_utc?: number
    has_verified_email?: boolean
    icon_img?: string
    snoovatar_img?: string
    subreddit?: {
      public_description?: string
      description?: string
      icon_img?: string
    }
  }
}

/**
 * Fetch + parse `/user/<username>/about.json`. Returns null on any failure
 * (404, network, malformed JSON) — callers decide how to handle.
 */
export async function probeRedditProfile(username: string): Promise<RedditProfile | null> {
  if (!username || username.includes('/') || username.includes('?')) {
    // Defensive: username must be a bare handle, not a path or URL.
    return null
  }

  const url = `https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      // 8s hard cap — if Reddit is slow, prefer failing to blocking action dispatch.
      signal: AbortSignal.timeout(8_000),
    })
  } catch (err) {
    console.warn(`[reddit-probe] fetch failed for ${username}:`, err)
    return null
  }

  if (!res.ok) {
    // 404 = user doesn't exist; 403 = suspended/shadowbanned. Both mean we
    // can't probe — treat as no-data rather than a false "healthy" signal.
    console.warn(`[reddit-probe] ${username}: ${res.status} ${res.statusText}`)
    return null
  }

  let json: AboutJsonResponse
  try {
    json = (await res.json()) as AboutJsonResponse
  } catch (err) {
    console.warn(`[reddit-probe] ${username}: malformed JSON`, err)
    return null
  }

  const d = json.data ?? {}
  const name = d.name ?? username
  const linkKarma = typeof d.link_karma === 'number' ? d.link_karma : 0
  const commentKarma = typeof d.comment_karma === 'number' ? d.comment_karma : 0
  const totalKarma =
    typeof d.total_karma === 'number' ? d.total_karma : linkKarma + commentKarma

  const createdUtc = typeof d.created_utc === 'number' ? d.created_utc : null
  const accountAgeDays =
    createdUtc !== null
      ? Math.floor((Date.now() / 1000 - createdUtc) / 86_400)
      : 0

  // Reddit default avatars live on www.redditstatic.com/avatars/. Anything
  // else is user-uploaded. snoovatar_img being set also indicates a non-default.
  const iconImg = d.icon_img ?? d.subreddit?.icon_img ?? ''
  const snoo = d.snoovatar_img ?? ''
  const hasAvatar = Boolean(
    snoo ||
      (iconImg &&
        !iconImg.includes('www.redditstatic.com/avatars/') &&
        !iconImg.includes('default-')),
  )

  const bio = d.subreddit?.public_description ?? d.subreddit?.description ?? ''
  const hasBio = bio.trim().length > 0

  return {
    username: name,
    totalKarma,
    linkKarma,
    commentKarma,
    accountAgeDays,
    hasVerifiedEmail: Boolean(d.has_verified_email),
    hasAvatar,
    hasBio,
  }
}

/**
 * Resolve the Reddit username of the currently logged-in session by hitting
 * `/api/me.json` with the session cookies. This is the "no --label needed"
 * path — as long as the user is logged in (which they are, since we stored
 * the session), the cookies let Reddit tell us who they are.
 *
 * Used as a fallback when neither accountState.metrics.username nor
 * browserSession.accountLabel is available. Caches the result by pinning
 * it to accountState.metrics in the caller.
 *
 * Returns null if:
 *   - storageState has no reddit cookies (session is broken / logged out)
 *   - /api/me.json returns 401 / 403 (session expired)
 *   - response is malformed
 */
async function resolveUsernameFromCookies(
  storageState: BrowserStorageState,
): Promise<string | null> {
  // Keep only cookies that Reddit would send. Playwright stores domains
  // with a leading dot for wildcard cookies (`.reddit.com`) — include both.
  const redditCookies = storageState.cookies.filter((c) => {
    const d = c.domain.toLowerCase()
    return d === 'reddit.com' || d === '.reddit.com' || d.endsWith('.reddit.com')
  })
  if (redditCookies.length === 0) return null

  // Build Cookie header — just name=value pairs, no attributes.
  const cookieHeader = redditCookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')

  let res: Response
  try {
    res = await fetch('https://www.reddit.com/api/me.json', {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        Cookie: cookieHeader,
      },
      signal: AbortSignal.timeout(8_000),
    })
  } catch (err) {
    console.warn('[reddit-probe] me.json fetch failed:', err)
    return null
  }

  if (!res.ok) {
    console.warn(`[reddit-probe] me.json: ${res.status} ${res.statusText}`)
    return null
  }

  let json: { data?: { name?: string } } | null = null
  try {
    json = (await res.json()) as { data?: { name?: string } }
  } catch (err) {
    console.warn('[reddit-probe] me.json malformed:', err)
    return null
  }

  const name = json?.data?.name
  // Logged-out sessions return `{ kind: 'Listing', data: {...} }` with no
  // `name` — treat as null so we don't feed a bogus username to the probe.
  if (typeof name !== 'string' || name.length === 0) return null
  return name
}

/**
 * Get a fresh-enough Reddit profile for (userId), probing if the cached
 * metrics are older than PROBE_TTL_MS.
 *
 * The username is resolved in priority order:
 *   1. accountState.metrics.username — pinned by a previous successful probe
 *   2. browserSession.accountLabel   — what the user typed at connect time
 *   3. /api/me.json with session cookies — auto-resolved from stored login
 *   4. null → caller must handle (typically: refuse the action with a
 *      "reconnect with --label <username>" message, but in practice path 3
 *      almost always succeeds when the session is healthy)
 *
 * On success, persists the probe result AND the resolved username to
 * accountState.metrics so the next call skips the resolution step.
 *
 * Returns null if the username cannot be resolved or the profile probe fails.
 */
export async function loadRedditProfileCached(
  userId: string,
): Promise<{ state: AccountState; profile: RedditProfile } | null> {
  const state = (await loadAccountState(userId, 'reddit')) ?? {}
  const cached = state.metrics

  // Hit the cache if it's fresh AND we have the username on file.
  if (cached?.lastProbedAt && cached.username) {
    const age = Date.now() - new Date(cached.lastProbedAt).getTime()
    if (age < PROBE_TTL_MS) {
      return {
        state,
        profile: {
          username: cached.username,
          totalKarma: cached.karma ?? 0,
          linkKarma: 0, // not cached separately
          commentKarma: 0,
          accountAgeDays: cached.accountAgeDays ?? 0,
          hasVerifiedEmail: Boolean(cached.hasVerifiedEmail),
          hasAvatar: Boolean(cached.hasAvatar),
          hasBio: Boolean(cached.hasBio),
        },
      }
    }
  }

  // Cache miss or stale — resolve a username to probe with.
  let username = cached?.username
  const session = !username ? await loadBrowserSession(userId, 'reddit') : null
  if (!username && session) {
    username = session.accountLabel ?? undefined
  }
  // Last resort: ask Reddit directly who this session belongs to.
  if (!username && session?.storageState) {
    const resolved = await resolveUsernameFromCookies(
      session.storageState as BrowserStorageState,
    )
    username = resolved ?? undefined
  }
  if (!username) return null

  const profile = await probeRedditProfile(username)
  if (!profile) return null

  // Persist. Even on cache miss, one probe/call is fine.
  const nextState = await updateAccountState(userId, 'reddit', (cur) => ({
    ...cur,
    metrics: {
      ...(cur.metrics ?? {}),
      karma: profile.totalKarma,
      accountAgeDays: profile.accountAgeDays,
      hasVerifiedEmail: profile.hasVerifiedEmail,
      hasAvatar: profile.hasAvatar,
      hasBio: profile.hasBio,
      username: profile.username,
      lastProbedAt: new Date().toISOString(),
    },
  }))

  return { state: nextState ?? state, profile }
}
