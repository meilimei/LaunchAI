/**
 * runOneTick — execute exactly one warm-up/grooming cycle for one account.
 *
 * This is the single reusable entry point for autonomous account grooming,
 * extracted from `scripts/dev-warmup.ts` per docs/AUTOMATION_ROADMAP.md §5
 * (Stage 1: "extract runOneTick pure function … unlocks all three downstream
 * execution shapes"). Three callers wrap it:
 *
 *   - `scripts/dev-warmup.ts`  — thin CLI (manual, Stage 0).
 *   - a local loop script      — Stage 1 (single machine).
 *   - an Inngest scheduled fn   — Stage 2 (Fly worker, cron-driven).
 *
 * Design contract (keep it this way so all three callers stay trivial):
 *   - NO `process.env` reads. All config is passed in. (The CLI reads env and
 *     passes; the Inngest handler reads the event payload and passes.)
 *   - NO filesystem writes. Trajectory side-output goes through the optional
 *     `onTrajectory` sink (CLI writes tmp/, the worker can push to S3).
 *   - The DB side-effects on `browser_sessions.account_state` ARE persisted —
 *     that is intentional and is what makes the next tick see updated counters.
 *   - Idempotent per run: executes at most ONE action (the top planned step),
 *     mirroring the platform daily-cap / re-plan-after-each-action model.
 */
import {
  deriveStage,
  isInCooldown,
  loadAccountState,
} from '@/lib/browser/account-state'
import { getPlatformAdapter } from '@/lib/platforms/registry'
import {
  planWarmup,
  type WarmupContext,
  type WarmupPlan,
} from '@/lib/platforms/warmup-planner'
import type {
  AccountState,
  ActionRequest,
  ExecutionResult,
  PlatformId,
  RiskResult,
} from '@/lib/platforms/types'

export type TickOutcome =
  /** Platform-wide cooldown active — refused to plan or execute. */
  | 'cooldown'
  /** Daily action cap reached (soft, self-clearing). */
  | 'rate_limited'
  /** No grooming steps needed (e.g. account already posting_ready). */
  | 'idle'
  /** Plan-only run (execute=false): steps available but not dispatched. */
  | 'planned'
  /** execute=true but the adapter's pre-flight validation rejected step #1. */
  | 'validation_failed'
  /** execute=true and step #1 was dispatched (see executed.result.status). */
  | 'executed'

export interface TickTrajectory {
  userId: string
  platform: PlatformId
  action: ActionRequest
  result: ExecutionResult
  /** ISO-8601 timestamp of when the action returned. */
  at: string
}

export interface RunOneTickInput {
  userId: string
  platform: PlatformId
  context: WarmupContext
  /** Plan only when false/omitted; dispatch step #1 when true. */
  execute?: boolean
  /**
   * Optional sink for the executed action's full result + trajectory.
   * Called once, only when an action was actually dispatched. Keeping this a
   * callback (instead of writing files here) is what keeps runOneTick free of
   * env / filesystem coupling — see module header.
   */
  onTrajectory?: (record: TickTrajectory) => void | Promise<void>
}

export interface RunOneTickResult {
  userId: string
  platform: PlatformId
  outcome: TickOutcome
  /** Lifecycle stage derived at the start of the tick. */
  stage: NonNullable<AccountState['stage']>
  /** Account state loaded at the start of the tick (diagnostics / printing). */
  state: AccountState | null
  /** Plan computed at the start of the tick. */
  plan: WarmupPlan
  /** Present when outcome is 'executed' or 'validation_failed'. */
  executed?: {
    action: ActionRequest
    validation: RiskResult
    /** Undefined when validation failed (we never reached executeAction). */
    result?: ExecutionResult
  }
  /** Re-planned preview AFTER execution — lets the scheduler queue the next. */
  nextPlan?: WarmupPlan
  /** Earliest time the next write action is allowed. */
  blockedUntil?: Date
  blockedReason?: NonNullable<AccountState['cooldownReason']>
}

export async function runOneTick(
  input: RunOneTickInput,
): Promise<RunOneTickResult> {
  const { userId, platform, context, execute = false } = input

  const state = await loadAccountState(userId, platform)
  const stage = deriveStage(state)

  // 1. Platform-wide cooldown — refuse to plan or execute.
  if (isInCooldown(state)) {
    const blockedUntil = state?.cooldownUntil
      ? new Date(state.cooldownUntil)
      : undefined
    return {
      userId,
      platform,
      outcome: 'cooldown',
      stage,
      state,
      plan: {
        stage: 'paused',
        steps: [],
        blockedUntil,
        blockedReason: state?.cooldownReason,
      },
      blockedUntil,
      blockedReason: state?.cooldownReason,
    }
  }

  const plan = planWarmup(platform, state, context)

  // 2. Nothing to do: either a soft daily-cap block or genuinely idle.
  if (plan.steps.length === 0) {
    const outcome: TickOutcome =
      plan.blockedReason === 'rate_limit' && plan.blockedUntil
        ? 'rate_limited'
        : 'idle'
    return {
      userId,
      platform,
      outcome,
      stage: plan.stage,
      state,
      plan,
      blockedUntil: plan.blockedUntil,
      blockedReason: plan.blockedReason,
    }
  }

  // 3. Plan-only mode.
  if (!execute) {
    return { userId, platform, outcome: 'planned', stage: plan.stage, state, plan }
  }

  // 4. Execute step #1 only — the planner is re-run after each action so the
  //    daily cap and freshly-persisted counters gate the next dispatch.
  const top = plan.steps[0]!
  const adapter = getPlatformAdapter(platform)
  const action: ActionRequest = { ...top.action, userId }

  const validation = await adapter.validateAction(action)
  if (!validation.ok) {
    return {
      userId,
      platform,
      outcome: 'validation_failed',
      stage: plan.stage,
      state,
      plan,
      executed: { action, validation },
    }
  }

  const result = await adapter.executeAction(action)

  if (input.onTrajectory) {
    await input.onTrajectory({
      userId,
      platform,
      action,
      result,
      at: new Date().toISOString(),
    })
  }

  // 5. Re-plan against the state the adapter just persisted (grooming counters,
  //    any cooldown the platform imposed) so callers know what comes next.
  const nextState = await loadAccountState(userId, platform)
  const nextPlan = planWarmup(platform, nextState, context)

  return {
    userId,
    platform,
    outcome: 'executed',
    stage: plan.stage,
    state,
    plan,
    executed: { action, validation, result },
    nextPlan,
    blockedUntil: nextPlan.blockedUntil,
    blockedReason: nextPlan.blockedReason,
  }
}
