/**
 * Hacker News engage candidate probe.
 *
 * Pulls recent stories from the public Algolia HN search API, filters for
 * "safe to reply on" targets (Show HN / Ask HN by default — discussion-
 * seeking threads where a thoughtful reply is welcome), and hands the
 * engage action a short permalinked shortlist.
 *
 * Why pre-resolve server-side:
 *   HN's homepage is a <table> with 30 unlabelled rows. Asking the agent
 *   to browse + pick burns steps on layout translation that Readability
 *   doesn't help with. The Algolia index is free, keyless, and refreshed
 *   in near-real-time, so we filter+rank deterministically here and give
 *   the agent a list of item urls.
 *
 * API reference: https://hn.algolia.com/api (no auth, generous rate limit).
 */

// ────────────────────────────────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────────────────────────────────

/**
 * Upper age bound. HN's front-page churn is high; a 24h-old story with
 * activity is still a valid engage target (discussion often peaks on day 2).
 * Going older risks replying to dead threads nobody reads.
 */
const MAX_AGE_HOURS = 36

/**
 * Minimum comments: a thread with 0-2 comments usually means nobody cared
 * (either the submitter is too niche or the timing was bad). Replying in
 * an empty thread produces 1 view, which is wasted effort.
 */
const MIN_COMMENTS = 3

/**
 * Maximum comments: threads with 300+ comments are over-saturated — a new
 * top-level comment is buried below the fold on submit. Engagement on
 * high-comment-count threads should use threaded replies, which is a
 * different skill.
 */
const MAX_COMMENTS = 300

/**
 * How many candidates to fetch from Algolia before filtering. We need
 * headroom because ~50% of hits fail the filters (dead, flagged, too old,
 * too quiet). 30 typically yields 5-10 passable candidates.
 */
const HITS_PER_PAGE = 30

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** Shape the engage prompt renders. Platform-specific fields only. */
export interface HNEngageCandidate {
  /** HN's internal item id. Used to build the canonical url. */
  itemId: number
  /** Full title as shown on HN. */
  title: string
  /** Canonical thread URL on news.ycombinator.com. */
  url: string
  /** External URL for link-stories, null for text submissions. */
  externalUrl: string | null
  /** Author's HN handle, without the leading @. */
  author: string
  /** Points at scrape time — not a hard filter, just a quality hint. */
  points: number
  /** Comment count at scrape time. */
  numComments: number
  /** Age in hours (rounded to one decimal). */
  ageHours: number
  /**
   * Story text for Ask HN / Show HN self-posts (cleaned and truncated).
   * Empty for link stories — the agent reads the linked article separately
   * if needed (usually not needed for engage; the title + body is enough).
   */
  bodySnippet: string
  /**
   * Which class this hit matched — informs the voice (Show HN welcomes
   * feedback, Ask HN wants specific answers, plain story wants substantive
   * comment).
   */
  kind: 'show' | 'ask' | 'story'
}

/** Story-class selector for the candidate fetcher. */
export type HNStoryKind = 'show' | 'ask' | 'story'

/** Raw Algolia hit shape — only the fields we read. */
interface AlgoliaHit {
  objectID: string
  title?: string | null
  url?: string | null
  author?: string | null
  points?: number | null
  num_comments?: number | null
  created_at_i?: number | null
  story_text?: string | null
  _tags?: string[]
}

interface AlgoliaResponse {
  hits: AlgoliaHit[]
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function kindFromTags(tags: string[] | undefined): HNStoryKind {
  if (!tags) return 'story'
  if (tags.includes('show_hn')) return 'show'
  if (tags.includes('ask_hn')) return 'ask'
  return 'story'
}

/**
 * Strip HTML and truncate self-post bodies. HN's story_text is served as
 * HTML with <p> separators and occasional <a>/<code>; we only need enough
 * to ground the agent's reply angle.
 */
function cleanSnippet(html: string): string {
  if (!html) return ''
  const text = html
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= 280) return text
  return text.slice(0, 280).replace(/\s+\S*$/, '') + '…'
}

/**
 * Build the Algolia tag-filter expression.
 *
 * Algolia uses `(a,b)` for OR within a tag group and comma between groups
 * for AND. We want "story of any requested kind"; kinds map to tags as
 * show→show_hn, ask→ask_hn, story→story.
 *
 * Note: `show_hn` and `ask_hn` are SUBSETS of `story` in Algolia's index.
 * If the caller asks for `['show', 'ask', 'story']` we just use `story`
 * (which matches everything) to keep the query simple.
 */
function buildTagFilter(kinds: readonly HNStoryKind[]): string {
  const set = new Set(kinds)
  if (set.has('story') || (set.has('show') && set.has('ask') && set.size === 2)) {
    // Broad net → use `story` alone, then filter locally by kind if needed.
    return 'story'
  }
  const tags: string[] = []
  if (set.has('show')) tags.push('show_hn')
  if (set.has('ask')) tags.push('ask_hn')
  if (tags.length === 1) return tags[0]!
  return `(${tags.join(',')})`
}

/**
 * Score a candidate for reply-worthiness. Higher = better target.
 *
 * Preferences (in order):
 *   1. Ask HN (asks for help → a concrete answer lands well)
 *   2. Show HN (welcomes feedback from builders)
 *   3. Self-post stories with body text (have a hook to react to)
 *   4. Newer > older within the window
 *   5. Moderate comment counts (20-80) — enough eyeballs, not saturated
 */
function scoreCandidate(c: HNEngageCandidate): number {
  let score = 0
  if (c.kind === 'ask') score += 1000
  else if (c.kind === 'show') score += 800
  else if (c.bodySnippet) score += 400

  // Freshness bonus: 0-6h → up to +100, tapers to 0 at MAX_AGE_HOURS.
  const freshness = Math.max(0, 1 - c.ageHours / MAX_AGE_HOURS)
  score += Math.round(freshness * 100)

  // Comment-count sweet spot: peaks around 40, falls off either side.
  const n = c.numComments
  if (n >= 20 && n <= 80) score += 50
  else if (n >= 10 && n < 20) score += 20
  else if (n > 80 && n <= 150) score += 10

  return score
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fetch recent HN stories matching the requested kinds, filter + rank for
 * reply-worthiness, and return at most `limit` candidates.
 *
 * Network cost: one GET to hn.algolia.com (~200ms typical). No auth.
 *
 * @param kinds   which story classes to consider. Defaults to ['show', 'ask'].
 * @param opts.limit          max candidates to return (default 5)
 * @param opts.topicKeywords  optional case-insensitive substrings the title
 *                            or body must contain. Use sparingly — narrower
 *                            topic filters drop 80%+ of hits.
 */
export async function fetchHNEngageCandidates(
  kinds: readonly HNStoryKind[] = ['show', 'ask'],
  opts?: { limit?: number; topicKeywords?: readonly string[] },
): Promise<HNEngageCandidate[]> {
  const limit = opts?.limit ?? 5
  const topicKeywords = (opts?.topicKeywords ?? []).map((k) => k.toLowerCase())
  const nowSec = Math.floor(Date.now() / 1000)
  const sinceSec = nowSec - MAX_AGE_HOURS * 3600

  const tag = buildTagFilter(kinds)
  const params = new URLSearchParams({
    tags: tag,
    hitsPerPage: String(HITS_PER_PAGE),
    // AND-chained numeric filters: fresh AND has-some-discussion.
    numericFilters: `created_at_i>${sinceSec},num_comments>${MIN_COMMENTS - 1}`,
  })
  // Sort by date so the newest stories come first — combined with our
  // per-candidate freshness score this biases toward "still discussable".
  const url = `https://hn.algolia.com/api/v1/search_by_date?${params.toString()}`

  let data: AlgoliaResponse
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'LaunchAI-dev/0.1 (engage-candidates)' },
    })
    if (!res.ok) {
      throw new Error(`Algolia HN returned HTTP ${res.status}`)
    }
    data = (await res.json()) as AlgoliaResponse
  } catch (err) {
    // The engage action can still proceed with an empty list — the skill
    // renders an explicit "no candidates" message and the agent finishes
    // with blocked_reason='no_target'. Better than throwing and wedging
    // the warmup loop.
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[hn-candidates] Algolia fetch failed: ${msg}`)
    return []
  }

  const candidates: HNEngageCandidate[] = []
  for (const h of data.hits ?? []) {
    if (!h.objectID || !h.title) continue
    const itemId = Number.parseInt(h.objectID, 10)
    if (!Number.isFinite(itemId)) continue

    const n = h.num_comments ?? 0
    if (n < MIN_COMMENTS || n > MAX_COMMENTS) continue

    const createdAt = h.created_at_i ?? 0
    const ageHours = (nowSec - createdAt) / 3600
    if (ageHours > MAX_AGE_HOURS || ageHours < 0) continue

    const kind = kindFromTags(h._tags)
    // If the caller asked for a narrower set, enforce it after the fact
    // (buildTagFilter may have widened the query to `story`).
    if (!kinds.includes(kind)) continue

    const bodySnippet = cleanSnippet(h.story_text ?? '')

    // Topic filter — keep if ANY keyword matches title or body.
    if (topicKeywords.length > 0) {
      const haystack = `${h.title} ${bodySnippet}`.toLowerCase()
      const hit = topicKeywords.some((k) => haystack.includes(k))
      if (!hit) continue
    }

    candidates.push({
      itemId,
      title: h.title,
      url: `https://news.ycombinator.com/item?id=${itemId}`,
      externalUrl: h.url && h.url.length > 0 ? h.url : null,
      author: h.author ?? '',
      points: h.points ?? 0,
      numComments: n,
      ageHours: Math.round(ageHours * 10) / 10,
      bodySnippet,
      kind,
    })
  }

  candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
  return candidates.slice(0, limit)
}

/**
 * Render the candidate list as a prompt-friendly block. Kept parallel to
 * Reddit's formatter so the engage skill sees a consistent shape across
 * platforms.
 */
export function formatHNCandidatesForPrompt(
  candidates: readonly HNEngageCandidate[],
): string {
  if (candidates.length === 0) {
    return '(no candidates resolved — the engage action will finish false with evidence="no_candidates")'
  }
  return candidates
    .map((c, i) => {
      const kindLabel =
        c.kind === 'show' ? 'Show HN' : c.kind === 'ask' ? 'Ask HN' : 'story'
      const lines = [
        `[${i + 1}] ${kindLabel} — "${c.title}"`,
        `    url: ${c.url}`,
        `    ${c.points} points, ${c.numComments} comments, ${c.ageHours}h old, by ${c.author}`,
      ]
      if (c.externalUrl) {
        lines.push(`    linked: ${c.externalUrl}`)
      }
      if (c.bodySnippet) {
        lines.push(`    OP: "${c.bodySnippet}"`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}
