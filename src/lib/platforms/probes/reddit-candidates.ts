/**
 * Server-side pre-resolution of reply targets for the Reddit `engage` action.
 *
 * Why this exists:
 *   Letting the browser agent discover candidate posts in-browser is both
 *   expensive (each `navigate` + `read_main_content` costs ~3 steps and
 *   ~$0.002) and unreliable (Reddit's listing pages extract poorly through
 *   Readability). The agent would routinely burn 20+ steps cycling
 *   extraction tools before giving up.
 *
 *   Instead we pre-fetch `/r/<sub>/hot.json` on our server, filter for
 *   good reply targets, and hand the agent a short list of permalinks
 *   directly in the goal prompt. The agent then only has to: pick one,
 *   navigate, read, draft, post. ~10 steps instead of 40.
 *
 * ToS note:
 *   The .json endpoint is part of Reddit's public surface and our fetches
 *   are unauthenticated, low-volume, and bear a descriptive User-Agent.
 *   Same compliance posture as the karma probe in reddit-profile.ts.
 */

/** User-Agent — Reddit's API 429s blank or generic UAs. */
const USER_AGENT = 'LaunchAI/0.1 (+https://github.com/LaunchAI) engage-candidate-probe'

/** Per-fetch timeout. Reddit's JSON API is usually <1s; 8s is very generous. */
const FETCH_TIMEOUT_MS = 8_000

/** Number of posts to inspect per subreddit before filtering. */
const LIMIT_PER_SUB = 25

/** Max age for a candidate. Older posts rarely reward new replies. */
const MAX_AGE_HOURS = 24

/** Minimum existing comments — ensures the thread is alive. */
const MIN_COMMENTS = 30

/**
 * Maximum comments — very-big threads are a karma trap for new accounts
 * because the reply will be buried. 2000 is a reasonable ceiling for the
 * safe subs (AskReddit megathreads routinely hit 10k+).
 */
const MAX_COMMENTS = 2_000

/** Titles matching these patterns are megathread-style containers — skip. */
const MEGATHREAD_TITLE_PATTERNS: RegExp[] = [
  /weekly (thread|discussion|question|roundup)/i,
  /daily (thread|discussion|question)/i,
  /megathread/i,
  /what are you working on/i,
  /share your/i,
  /shill ?(thursday|sunday|saturday)/i,
  /^\[?meta\]?/i,
]

export interface EngageCandidate {
  subreddit: string
  title: string
  permalink: string
  /** Absolute URL using old.reddit.com for consistency with the engage flow. */
  url: string
  numComments: number
  ageHours: number
  /** First 240 chars of OP's body, cleaned. Empty for link posts. */
  bodySnippet: string
  /** Useful for agent reasoning: avoid replying to own posts. */
  author: string
}

interface RawRedditPost {
  subreddit?: string
  title?: string
  permalink?: string
  num_comments?: number
  created_utc?: number
  stickied?: boolean
  locked?: boolean
  over_18?: boolean
  is_self?: boolean
  selftext?: string
  author?: string
  distinguished?: string | null
}

interface RawRedditListing {
  data?: {
    children?: Array<{ kind?: string; data?: RawRedditPost }>
  }
}

async function fetchSubredditHot(subreddit: string): Promise<RawRedditPost[]> {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/hot.json?limit=${LIMIT_PER_SUB}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    console.warn(`[reddit-candidates] fetch r/${subreddit} failed:`, err)
    return []
  }
  if (!res.ok) {
    console.warn(`[reddit-candidates] r/${subreddit}: ${res.status} ${res.statusText}`)
    return []
  }
  let json: RawRedditListing
  try {
    json = (await res.json()) as RawRedditListing
  } catch (err) {
    console.warn(`[reddit-candidates] r/${subreddit} malformed JSON:`, err)
    return []
  }
  const children = json.data?.children ?? []
  // `kind === 't3'` filters out mod-inserted junk; every real post is t3.
  return children.filter((c) => c.kind === 't3').map((c) => c.data ?? {})
}

function isMegathreadTitle(title: string): boolean {
  return MEGATHREAD_TITLE_PATTERNS.some((p) => p.test(title))
}

function cleanSnippet(raw: string): string {
  const flat = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/https?:\/\/\S+/g, '<link>')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length <= 240 ? flat : flat.slice(0, 237) + '...'
}

/**
 * Pull hot posts from each subreddit, filter for engage-friendly targets,
 * rank by a simple "reply-worthiness" heuristic, and return at most `limit`.
 *
 * Ranking (descending):
 *   1. self-posts (is_self) before link posts — body is easier to react to
 *   2. newer before older (fresher = more eyeballs on new replies)
 *   3. moderate comment counts (sweet spot around MIN_COMMENTS..500)
 *
 * The adapter passes these into the engage goalTemplate so the agent sees
 * a concrete shortlist rather than "go find something".
 */
export async function fetchRedditEngageCandidates(
  subreddits: readonly string[],
  opts?: { limit?: number },
): Promise<EngageCandidate[]> {
  const limit = opts?.limit ?? 5
  const nowSec = Date.now() / 1000

  // Fetch all subs in parallel. 5-7 subs × ~500ms = ~500ms total.
  const allPosts = await Promise.all(subreddits.map(fetchSubredditHot))

  const candidates: EngageCandidate[] = []
  for (const [i, posts] of allPosts.entries()) {
    const subName = subreddits[i]!
    for (const p of posts) {
      if (!p.title || !p.permalink) continue
      if (p.stickied) continue
      if (p.locked) continue
      if (p.over_18) continue
      if (p.distinguished) continue // mod or admin post
      if (isMegathreadTitle(p.title)) continue

      const ageSec = nowSec - (p.created_utc ?? 0)
      const ageHours = ageSec / 3600
      if (ageHours > MAX_AGE_HOURS || ageHours < 0) continue

      const n = p.num_comments ?? 0
      if (n < MIN_COMMENTS || n > MAX_COMMENTS) continue

      const isSelf = Boolean(p.is_self)
      const body = isSelf ? cleanSnippet(p.selftext ?? '') : ''
      // Skip self-posts with no body text at all — nothing to react to.
      if (isSelf && !body) continue

      candidates.push({
        subreddit: p.subreddit ?? subName,
        title: p.title,
        permalink: p.permalink,
        // Force old.reddit.com to match the engage workflow's reader path.
        url: `https://old.reddit.com${p.permalink}`,
        numComments: n,
        ageHours: Math.round(ageHours * 10) / 10,
        bodySnippet: body,
        author: p.author ?? '',
      })
    }
  }

  // Score: self-posts get +1000, newer +small, moderate-size +small.
  candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
  return candidates.slice(0, limit)
}

function scoreCandidate(c: EngageCandidate): number {
  const selfBonus = c.bodySnippet ? 1_000 : 0
  // Newer is slightly better, capped at 24h.
  const recencyBonus = Math.max(0, 24 - c.ageHours) * 5
  // Sweet-spot bonus: MIN_COMMENTS..500 → full; 500..2000 → decay.
  const countBonus =
    c.numComments <= 500
      ? 100
      : Math.max(0, 100 - (c.numComments - 500) / 15)
  return selfBonus + recencyBonus + countBonus
}

/**
 * Render a candidates shortlist as markdown-ish plain text for injection
 * into the engage goal prompt. Keeps each candidate compact (~5 lines)
 * so even 5 candidates stay under 1500 chars.
 */
export function formatCandidatesForPrompt(candidates: EngageCandidate[]): string {
  if (candidates.length === 0) {
    return '(no candidates resolved — the engage action will finish false with evidence="no_candidates")'
  }
  return candidates
    .map((c, i) => {
      const lines = [
        `[${i + 1}] r/${c.subreddit} — "${c.title}"`,
        `    url: ${c.url}`,
        `    ${c.numComments} comments, ${c.ageHours}h old, by u/${c.author}`,
      ]
      if (c.bodySnippet) {
        lines.push(`    OP: "${c.bodySnippet}"`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}
