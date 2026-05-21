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
 * Plan the next grooming steps by iterating the platform manifest's
 * warm-up rules. Each rule is a `{ when, produce, reason }` triple
 * — see PlatformManifest.warmupRules.
 *
 * Cooldown short-circuits everything: if the account is currently in
 * cooldown, the planner returns no steps and signals `blockedUntil`.
 */
export function planWarmup(
  platform: PlatformId,
  state: AccountState | null,
  ctx: WarmupContext,
): WarmupPlan {
  const s: AccountState = state ?? {}

  // Hard block — supervisor must not schedule any writes.
  if (s.cooldownUntil && new Date(s.cooldownUntil).getTime() > Date.now()) {
    return {
      stage: 'paused',
      steps: [],
      blockedUntil: new Date(s.cooldownUntil),
      blockedReason: s.cooldownReason,
    }
  }

  const manifest = getManifest(platform)
  const steps: PlannedStep[] = []
  for (const rule of manifest.warmupRules) {
    if (rule.when(s)) {
      steps.push({
        reason: rule.reason(s),
        action: rule.produce(s, ctx),
      })
    }
  }

  // Stage derivation — platform-agnostic. Mirrors deriveStage().
  const profile = s.profile ?? {}
  const warmup = s.warmup ?? {}
  const profileComplete = Boolean(
    profile.bioSet && profile.avatarSet && profile.websiteSet,
  )
  let stage: NonNullable<AccountState['stage']> = 'fresh'
  if (profileComplete) {
    const minWarmup =
      (warmup.followsCompleted ?? 0) >= MIN_FOLLOWS &&
      (warmup.upvotesCompleted ?? 0) >= MIN_UPVOTES
    stage = minWarmup ? 'posting_ready' : 'warming'
  }

  return { stage, steps }
}
