/**
 * Warm-up planner — decides the next grooming action(s) for a connected
 * account based on its current state and the user's campaign context.
 *
 * Pure function. No I/O. The caller (a dev script today, the supervisor
 * later) is responsible for loading state, dispatching the chosen action,
 * and re-planning afterwards.
 *
 * The planner is platform-agnostic: it iterates the warm-up rules in the
 * platform's manifest. To add new rules, edit the manifest — not this file.
 *
 * Two short-circuits run BEFORE rule iteration, in order:
 *   1. Cooldown — if the account has an unexpired platform-wide cooldown,
 *      return paused + blockedUntil. Read in account-state.ts:isInCooldown.
 *   2. dailyActionCap — count grooming-action timestamps from the last 24h
 *      against `manifest.capabilities.dailyActionCap`. At-or-above the cap
 *      returns no steps + blockedUntil = oldest_in_window + 24h (the
 *      earliest moment the sliding window will free a slot).
 *
 * See docs/ACCOUNT_GROOMING.md §5 and docs/PLATFORM_EXTENSIBILITY.md §3.
 */
import { getManifest } from './manifests'
import type { AccountState, ActionRequest, PlatformId } from './types'

/**
 * Context the planner needs about the user's product. In the long run this
 * comes from the `campaigns` row; for now the dev:warmup script supplies
 * it on the command line / from a fixture.
 */
export interface WarmupContext {
  campaignId: string
  /** Short product name, used in default bio when user did not pin one. */
  productName: string
  /** One-sentence product description, used as default bio. */
  productOneLiner: string
  /** Public landing URL for the product. */
  productUrl: string
  /**
   * Topic / domain phrase the agent uses to find peers to follow / upvote.
   * E.g. "Chrome extensions for productivity", "AI tools for founders".
   */
  topic: string
  /** Optional: explicit URL to product logo/avatar. */
  avatarUrl?: string
  /** Optional: explicit display name. */
  displayName?: string
}

export interface PlannedStep {
  /** Human-readable rationale, persisted to decision_logs. */
  reason: string
  /** The action the planner wants enqueued. */
  action: Omit<ActionRequest, 'userId'>
}

export interface WarmupPlan {
  /** The lifecycle stage the planner derived from state. */
  stage: NonNullable<AccountState['stage']>
  /** Next step in priority order (caller picks #1; further entries are previews). */
  steps: PlannedStep[]
  /** If non-null, supervisor MUST wait until this time before any write actions. */
  blockedUntil?: Date
  /** Diagnostic — why blocked. */
  blockedReason?: NonNullable<AccountState['cooldownReason']>
}

// Thresholds used to derive the lifecycle stage from raw counters.
// Kept in sync with deriveStage() in account-state.ts.
const MIN_FOLLOWS = 10
const MIN_UPVOTES = 15

/**
 * Sliding window for the per-day soft cap on autonomous grooming actions.
 * 24h matches the platform-side spam-filter horizon Reddit / IH / HN use
 * when grouping rapid activity from a single account.
 */
const ACTION_CAP_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Derive the lifecycle stage from raw state — platform-agnostic, no
 * cooldown handling (the planner short-circuits cooldown above this).
 * Mirrors deriveStage() in account-state.ts (sans the paused branch);
 * tests should treat both as one source of truth.
 */
function deriveStageFromState(
  s: AccountState,
): NonNullable<AccountState['stage']> {
  const profile = s.profile ?? {}
  const warmup = s.warmup ?? {}
  const profileComplete = Boolean(
    profile.bioSet && profile.avatarSet && profile.websiteSet,
  )
  if (!profileComplete) return 'fresh'
  const minWarmup =
    (warmup.followsCompleted ?? 0) >= MIN_FOLLOWS &&
    (warmup.upvotesCompleted ?? 0) >= MIN_UPVOTES
  return minWarmup ? 'posting_ready' : 'warming'
}

/**
 * Plan the next grooming steps by iterating the platform manifest's
 * warm-up rules. Each rule is a `{ when, produce, reason }` triple
 * — see PlatformManifest.warmupRules.
 *
 * Short-circuits in priority order:
 *   1. Cooldown (platform refused writes until cooldownUntil).
 *   2. dailyActionCap reached in the last 24h (rate_limit, soft).
 * Otherwise iterate the manifest rules.
 */
export function planWarmup(
  platform: PlatformId,
  state: AccountState | null,
  ctx: WarmupContext,
): WarmupPlan {
  const s: AccountState = state ?? {}

  // 1. Hard block — supervisor must not schedule any writes during
  //    a platform-imposed cooldown.
  if (s.cooldownUntil && new Date(s.cooldownUntil).getTime() > Date.now()) {
    return {
      stage: 'paused',
      steps: [],
      blockedUntil: new Date(s.cooldownUntil),
      blockedReason: s.cooldownReason,
    }
  }

  const manifest = getManifest(platform)

  // 2. Soft block — daily action cap reached. Counts grooming actions
  //    (follow / upvote / engage) recorded by recordGroomingAction in
  //    the last 24h. Post / comment do NOT push timestamps and are
  //    user-driven anyway, so they don't count toward this cap.
  //
  //    blockedUntil = oldest_in_window + 24h (when the sliding window
  //    will next free a slot). Reason is 'rate_limit' (transient,
  //    self-clearing) — distinct from the platform 'rate_limit' cooldown
  //    in that this one is purely client-side and never persists.
  const cap = manifest.capabilities.dailyActionCap
  if (cap > 0) {
    const now = Date.now()
    const inWindow = (s.warmup?.recentActionTimestamps ?? [])
      .map((ts) => new Date(ts).getTime())
      .filter((t) => Number.isFinite(t) && now - t < ACTION_CAP_WINDOW_MS)
    if (inWindow.length >= cap) {
      const oldest = Math.min(...inWindow)
      return {
        stage: deriveStageFromState(s),
        steps: [],
        blockedUntil: new Date(oldest + ACTION_CAP_WINDOW_MS),
        blockedReason: 'rate_limit',
      }
    }
  }

  // 3. Normal path — iterate manifest warmup rules.
  const steps: PlannedStep[] = []
  for (const rule of manifest.warmupRules) {
    if (rule.when(s)) {
      steps.push({
        reason: rule.reason(s),
        action: rule.produce(s, ctx),
      })
    }
  }

  return { stage: deriveStageFromState(s), steps }
}
