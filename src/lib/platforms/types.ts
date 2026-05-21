/**
 * Platform adapter contract.
 *
 * Every external platform integration (X, Reddit, Product Hunt, HN, IH, CWS,
 * blog/CMS, etc.) implements this interface. The Campaign Supervisor reasons
 * in terms of typed actions; platform-specific quirks stay isolated here.
 *
 * Capabilities + risk levels honestly describe what each platform can/cannot
 * do given current API/ToS constraints. Plan: see
 *   plans/autonomous-marketing-os-17b3d4.md §11 "Platform adapter interface"
 *   plans/autonomous-marketing-os-17b3d4.md §8 "Autopilot safety model"
 */

export type PlatformId =
  | 'x'
  | 'reddit'
  | 'product_hunt'
  | 'hacker_news'
  | 'indie_hackers'
  | 'cws'
  | 'blog'

/**
 * 0 = read-only (crawling, metrics)
 * 1 = owned-channel publish (blog, changelog, scheduled X)
 * 2 = community publish (Reddit, HN, IH)
 * 3 = comments / replies
 * 4 = account / profile / listing changes
 *
 * Higher levels require stricter approval gates.
 */
export type RiskLevel = 0 | 1 | 2 | 3 | 4

/**
 * How the adapter actually executes write actions.
 *
 *   'api'              — exclusive OAuth/API path (e.g. Twitter v2)
 *   'browser'          — exclusive browser-driven path via runBrowserTask
 *   'hybrid'           — try API first, fall back to browser
 *   'browser_assisted' — agent prepares the draft, human clicks final submit
 *
 * See docs/BROWSER_AUTONOMY.md §6.
 */
export type ExecutionMode = 'api' | 'browser' | 'hybrid' | 'browser_assisted'

export interface PlatformCapabilities {
  canRead: boolean
  canPost: boolean
  canComment: boolean
  canCollectMetrics: boolean
  /** Default execution path for write actions. */
  executionMode: ExecutionMode
  /** True when even the browser path needs a human in the loop to finalize. */
  requiresHumanFinalize: boolean
  /** Highest risk level the adapter can autonomously emit. */
  maxAutonomousRiskLevel: RiskLevel
  /** Per-day soft cap on autonomous actions; supervisor enforces. */
  dailyActionCap: number
}

/**
 * The full action vocabulary the supervisor can dispatch.
 *
 * Content actions (existing):
 *   - post           : owned post on the platform (highest visibility)
 *   - comment        : top-level comment on someone else's content
 *   - reply          : reply in an existing thread
 *   - update_listing : edit a managed listing (CWS, blog, etc.)
 *   - send           : direct message / email
 *   - crawl          : read-only data collection
 *
 * Grooming actions (added in milestone G1, see docs/ACCOUNT_GROOMING.md):
 *   - set_profile : edit avatar / bio / display name / website on own profile
 *   - follow      : follow listed usernames or agent-picked peers
 *   - upvote      : upvote listed URLs or agent-picked posts
 *   - engage      : low-risk helpful / curious / congratulatory reply on others'
 *                   content. Self-promotion is forbidden (enforced in prompt).
 */
export type ActionType =
  | 'post'
  | 'comment'
  | 'reply'
  | 'update_listing'
  | 'send'
  | 'crawl'
  | 'set_profile'
  | 'follow'
  | 'upvote'
  | 'engage'

export interface ActionRequest {
  /** Owner of the campaign — drives session/integration lookup. */
  userId: string
  campaignId: string
  taskId?: string
  type: ActionType
  riskLevel: RiskLevel
  payload: Record<string, unknown>
  /** Optional: scheduled execution time. */
  scheduledAt?: Date
}

export interface RiskResult {
  ok: boolean
  reasons: string[]
  /** Recommended action if not ok: 'approve' = ask user, 'block' = drop. */
  recommendation: 'execute' | 'approve' | 'block'
  /** Adapter-specific risk score 0–1 (higher = riskier). */
  score?: number
}

export interface ExecutionResult {
  status: 'ok' | 'failed' | 'deferred'
  externalId?: string
  externalUrl?: string
  raw?: unknown
  error?: string
  /**
   * If the platform imposed a cooldown (rate limit, new-account block, karma
   * threshold, etc.), the adapter MUST set this so the supervisor knows when
   * it is safe to retry write actions on this account.
   *
   * See docs/ACCOUNT_GROOMING.md §4.
   */
  cooldownUntil?: Date
  cooldownReason?: AccountState['cooldownReason']
}

/**
 * Persisted per-account state — lives in `browser_sessions.account_state`
 * (jsonb). Drives the warm-up planner and supervisor scheduling decisions.
 *
 * See docs/ACCOUNT_GROOMING.md §3.
 */
export interface AccountState {
  stage?: 'fresh' | 'warming' | 'posting_ready' | 'active' | 'paused'
  profile?: {
    avatarSet?: boolean
    bioSet?: boolean
    displayNameSet?: boolean
    websiteSet?: boolean
    notes?: string
  }
  warmup?: {
    followsCompleted?: number
    upvotesCompleted?: number
    engagementsCompleted?: number
    /** ISO-8601 timestamps; bounded to last 30 entries by the store. */
    recentActionTimestamps?: string[]
  }
  /** ISO-8601 string — platform refused write actions until this time. */
  cooldownUntil?: string
  cooldownReason?:
    | 'new_account'
    | 'karma_threshold'
    | 'rate_limit'
    | 'verify_email'
    | 'captcha'
    | 'manual_review'
    | 'subreddit_rules'
    /**
     * Soft-defer: the agent ran but found no suitable target / its drafts
     * all failed self-review. The platform did NOT refuse anything — we
     * just chose not to act this run. Short cooldown (~1h) so the next
     * candidate set has time to refresh; explicitly NOT a manual_review
     * (which implies a moderator gate and pauses for ~30 days).
     */
    | 'no_target'
    | 'unknown'
  cooldownEvidence?: string
  /**
   * Reddit-only — per-subreddit state. Lets the supervisor avoid one banned
   * sub locking the whole Reddit account. Keys are subreddit names without
   * the `r/` prefix, lowercase ('chatgpt', 'privacy').
   *
   * Persisted alongside platform-wide cooldown so a sub-rules block does not
   * trigger a global account cooldown.
   */
  subredditState?: Record<string, SubredditState>
  /**
   * Read-only measurements probed from the platform (karma, account age,
   * verified-email status, etc.). Distinct from `profile` (which tracks
   * whether WE have set fields) and `warmup` (which tracks OUR actions).
   * These are properties of the account that the platform exposes and we
   * cache to avoid re-probing on every decision. Written by per-platform
   * probes (e.g. probeRedditProfile) and read by preActionGate logic.
   */
  metrics?: {
    /** Platform karma / score / reputation number. Reddit sums link+comment. */
    karma?: number
    /** Age of the account in whole days, computed at probe time. */
    accountAgeDays?: number
    /** True if the platform flags this account as email-verified. */
    hasVerifiedEmail?: boolean
    /** True if the account has uploaded a non-default avatar. */
    hasAvatar?: boolean
    /** True if the account has a non-empty public bio / about. */
    hasBio?: boolean
    /** ISO-8601 of the last successful probe — used to skip re-probing. */
    lastProbedAt?: string
    /**
     * The handle / username the probe verified. Stored here so we don't
     * depend on accountLabel being set (or being correct) forever — one
     * successful probe pins it for future use.
     */
    username?: string
  }
  /** User-pinned overrides — the planner never rewrites these. */
  pinned?: {
    bio?: string
    website?: string
    displayName?: string
  }
}

/**
 * Per-subreddit slice of AccountState — Reddit-specific.
 *
 * `cooldownUntil` here is independent of the platform-wide `cooldownUntil`.
 * The supervisor must check both before dispatching a Reddit action that
 * targets a specific sub.
 */
export interface SubredditState {
  /** ISO-8601 of the last successful post in this sub. */
  lastPostAt?: string
  /** ISO-8601 of the last successful comment in this sub. */
  lastCommentAt?: string
  /** ISO-8601 — write actions to this sub refused until this time. */
  cooldownUntil?: string
  /** Why this sub is in cooldown. */
  cooldownReason?:
    | 'subreddit_rules'
    | 'rate_limit'
    | 'karma_threshold'
    | 'manual_review'
    | 'unknown'
  /** Verbatim text the agent saw, useful for review + dedup. */
  cooldownEvidence?: string
  /**
   * ISO-8601 — when we last verified the sub's rules / posting policy.
   * Lets the planner skip re-reading rules every time.
   */
  rulesVerifiedAt?: string
  /** Cached summary of what's allowed (self-promo, karma min, flair, etc). */
  rulesSummary?: string
}

export interface MetricsRef {
  externalId: string
  externalUrl?: string
}

export interface MetricsSnapshot {
  platform: PlatformId
  capturedAt: Date
  impressions?: number
  clicks?: number
  upvotes?: number
  comments?: number
  conversions?: number
  raw?: unknown
}

export interface PlatformAdapter {
  platform: PlatformId
  capabilities: PlatformCapabilities
  validateAction(action: ActionRequest): Promise<RiskResult>
  executeAction(action: ActionRequest): Promise<ExecutionResult>
  collectMetrics(ref: MetricsRef): Promise<MetricsSnapshot>
}
