/**
 * PlatformManifest — declarative description of a platform integration.
 *
 * The vision: a platform is data, not code. Every platform-specific thing
 * (URLs, login probes, action templates, cooldown patterns, warm-up plan)
 * lives in a typed manifest. A single `ManifestBrowserAdapter` consumes
 * any manifest and runs it.
 *
 * Adding a new platform:
 *   1. Create `src/lib/platforms/manifests/<platform>.manifest.ts` exporting
 *      a `PlatformManifest` constant.
 *   2. Add the platform id to PlatformId.
 *   3. Done — no new class, no logic changes.
 *
 * See docs/PLATFORM_EXTENSIBILITY.md for the layered architecture and
 * the migration plan from today's per-platform classes.
 */
import { z } from 'zod'
import type {
  AccountState,
  ActionRequest,
  ActionType,
  PlatformCapabilities,
  PlatformId,
  RiskLevel,
} from './types'
import type { WarmupContext } from './warmup-planner'

// ────────────────────────────────────────────────────────────────────────────
// Action recipes — declarative description of "how to do action X"
// ────────────────────────────────────────────────────────────────────────────

/**
 * Hooks the runtime invokes when an action succeeds. They update
 * `account_state` so the planner sees progress next time.
 *
 * Defined as named strings (not function refs) so manifests stay JSON-
 * serializable and remote-loadable later.
 */
export type SuccessHook =
  | 'none'
  | 'recordUpvote'
  | 'recordFollow'
  | 'recordEngagement'
  | 'recordProfileFields'
  /**
   * Reddit-specific. Reads `payload.subreddit` and bumps that sub's
   * lastPostAt / lastCommentAt timestamps. Also caches `output.rulesSummary`
   * if the agent extracted it.
   */
  | 'recordSubredditPost'
  | 'recordSubredditComment'

export interface ActionRecipe<P = unknown> {
  /** Zod schema for the action payload. Adapters use this for validation. */
  payloadSchema: z.ZodType<P>

  /**
   * The high-level goal handed to the browser agent.
   *
   * Three shapes supported:
   *   1. string — simple `{{key}}` interpolation against the payload
   *      (see `renderTemplate`). This is the default for static prompts.
   *   2. (payload) => string — synchronous render, e.g. when the prompt
   *      depends on payload shape beyond key interpolation.
   *   3. (payload) => Promise<string> — async render, used when the prompt
   *      wants server-side data that would be expensive or unreliable to
   *      fetch from the browser agent. Example: Reddit engage pre-fetches
   *      candidate posts via the public JSON API and embeds them in the
   *      prompt, saving 20+ agent steps and the cost of extractor tool
   *      calls that don't work well on listing pages.
   *
   * Keep it deterministic: don't tell the agent things like "be creative".
   * The agent's job is to operate the platform UI; creativity (post body,
   * comment text) is generated upstream by the Writer/Critic agents and
   * handed in via payload.
   */
  goalTemplate:
    | string
    | ((payload: P) => string)
    | ((payload: P) => Promise<string>)

  /**
   * Either a fixed start URL, the manifest's baseUrl when omitted, or
   * a function that derives the URL from the payload (e.g. comment.url).
   */
  startUrl?: string | ((payload: P) => string)

  /** Step + wallclock budgets. Reasonable defaults if omitted. */
  maxSteps?: number
  maxWallclockMs?: number

  /**
   * What the runtime persists to account_state on success. Adapters call
   * the corresponding helper in `account-state.ts`.
   */
  onSuccess?: SuccessHook

  /**
   * Optional payload-specific risk override. If absent, falls back to
   * `manifest.defaultRiskByActionType[type]`.
   */
  riskLevel?: RiskLevel
}

// ────────────────────────────────────────────────────────────────────────────
// Block / cooldown detection — patterns the agent reports
// ────────────────────────────────────────────────────────────────────────────

export type CooldownReason = NonNullable<AccountState['cooldownReason']>

export interface BlockedHint {
  /** Pattern matched against the agent's `evidence` text. */
  pattern: RegExp
  reason: CooldownReason
  /** Override default cooldown for this specific match. */
  retryHours?: number
  /** Plain-English rationale for review. */
  description: string
}

// ────────────────────────────────────────────────────────────────────────────
// Warm-up rules — platform-specific recipe for fresh → posting_ready
// ────────────────────────────────────────────────────────────────────────────

export interface WarmupRule {
  id: string
  /** Predicate: should this rule fire given current state? */
  when: (state: AccountState) => boolean
  /**
   * Produce the action this rule wants enqueued.
   *
   * The function is `pure` — it sees state + campaign context and returns
   * a fully-formed ActionRequest minus userId (the supervisor injects it).
   */
  produce: (
    state: AccountState,
    ctx: WarmupContext,
  ) => Omit<ActionRequest, 'userId'>
  /** Reason persisted to decision_logs. */
  reason: (state: AccountState) => string
}

// ────────────────────────────────────────────────────────────────────────────
// Login probe — used by connect:account, browser:check, runtime
// ────────────────────────────────────────────────────────────────────────────

export interface LoginProbe {
  /**
   * URL the script visits to verify session validity. Should require
   * authentication — typically /dashboard or /settings.
   */
  loggedInUrl: string
  /** If the final URL contains any of these, conclude logged-out. */
  loggedOutUrlMarkers: string[]
  /**
   * If any of these substrings appear in the page text, conclude logged-in.
   * Provide several so the probe survives minor UI copy changes.
   */
  loggedInTextMarkers: string[]
  /**
   * Optional tertiary signal: if any of these appear AND no logged-in
   * marker matches, conclude logged-out (catches "didn't redirect but
   * the page is the public marketing variant").
   */
  loggedOutTextMarkers?: string[]
}

// ────────────────────────────────────────────────────────────────────────────
// Audience profile — consumed by the Strategist (L3) to rank platform fit
// ────────────────────────────────────────────────────────────────────────────

export interface AudienceProfile {
  /**
   * One-line "who is on this platform" — written honestly, not aspirationally.
   * The Strategist LLM reads this verbatim when scoring fit.
   */
  summary: string
  /**
   * Coarse tags for fast keyword overlap with a campaign's ICP description.
   * Mix industries, role types, demographics, interests. Lowercase, kebab-case.
   * Examples: 'founders', 'b2b-saas', 'developers', 'lawyers', 'enterprise-it'.
   */
  tags: string[]
  /**
   * Optional — audience types this platform clearly does NOT serve well.
   * Helps the strategist exclude misfits early.
   * Examples: 'consumer', 'enterprise-procurement', 'non-technical'.
   */
  notSuitableFor?: string[]
}

// ────────────────────────────────────────────────────────────────────────────
// The manifest itself
// ────────────────────────────────────────────────────────────────────────────

/**
 * Verdict returned by a manifest's `preActionGate`.
 *
 * `deferred: false` → proceed with the action.
 * `deferred: true`  → adapter returns ExecutionResult.deferred immediately,
 *                     never launching the browser. Used for "account too fresh"
 *                     / karma-threshold / email-unverified gates where we can
 *                     know in advance the action will fail at the platform.
 */
export type PreActionGateVerdict =
  | { deferred: false }
  | {
      deferred: true
      reason: CooldownReason
      evidence: string
      /**
       * When to allow the action again. For permanent-seeming gates (user
       * must reconnect with a label, must warm up the account before a
       * mutating class of actions) use a long-ish cooldown (e.g. 24h) so
       * the planner knows to try again tomorrow.
       */
      cooldownUntil: Date
    }

export interface PlatformManifest {
  // Identity
  id: PlatformId
  displayName: string
  baseUrl: string
  loginUrl: string

  // Audience fit (Strategist L3 input)
  audienceProfile: AudienceProfile

  // Authentication / session
  loginProbe: LoginProbe

  // Capability matrix (drives risk + supervisor scheduling)
  capabilities: PlatformCapabilities
  defaultRiskByActionType: Partial<Record<ActionType, RiskLevel>>

  // Tone + community guardrails injected as system prompt addendum
  systemAddendum: string

  // Per-action recipes
  actions: Partial<Record<ActionType, ActionRecipe>>

  // Cooldown enforcement
  blockedHints: BlockedHint[]
  defaultCooldownHoursByReason: Record<CooldownReason, number>

  // Warm-up plan
  warmupRules: WarmupRule[]

  /**
   * Optional pre-execution gate. Called by ManifestBrowserAdapter before any
   * browser session is opened. Returning `deferred: true` short-circuits the
   * run — useful for hard pre-conditions the agent cannot recover from
   * inside the loop (account too fresh, email unverified, missing handle).
   *
   * Contract:
   *   - Must be cheap (<2s typical). Expensive probes should cache their
   *     result in account_state so repeat calls are free.
   *   - Runs ONLY for mutating action types. Read-only actions bypass it.
   *   - The adapter persists the returned cooldown via `recordCooldown`,
   *     so the supervisor sees the defer in the usual place.
   */
  preActionGate?: (
    action: ActionRequest,
    state: AccountState | null,
  ) => Promise<PreActionGateVerdict>
}

/**
 * Runtime helper — interpolate `{{key}}` against an object.
 *
 * Used by ManifestBrowserAdapter (when implemented) to render goalTemplate
 * with the action's payload before handing it to the agent.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const segments = path.split('.')
    let cur: unknown = vars
    for (const seg of segments) {
      if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[seg]
      } else {
        return ''
      }
    }
    if (cur === undefined || cur === null) return ''
    return typeof cur === 'string' ? cur : JSON.stringify(cur)
  })
}
