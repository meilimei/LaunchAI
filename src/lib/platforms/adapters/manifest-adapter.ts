/**
 * ManifestBrowserAdapter — the single PlatformAdapter implementation that
 * consumes any PlatformManifest and runs it.
 *
 * Replaces the per-platform classes (IndieHackersAdapter etc.) with a
 * data-driven adapter. Adding a new platform = creating a manifest;
 * no new class needed. See docs/PLATFORM_EXTENSIBILITY.md.
 *
 * The adapter is browser-driven by default. API-mode platforms (e.g. blog)
 * either skip this adapter entirely or extend it later — for now they
 * route through the same agent loop and the manifest declares no actions,
 * so executeAction returns "no recipe".
 */
import {
  NeedsReauthError,
  runBrowserTask,
  type RunBrowserTaskResult,
} from '@/lib/browser/run'
import {
  loadAccountState,
  recordCooldown,
  recordGroomingAction,
  recordProfileField,
  recordSubredditAction,
  recordSubredditCooldown,
  recordSubredditRules,
} from '@/lib/browser/account-state'
import { loadBrowserSession } from '@/lib/browser/session-store'
import {
  renderTemplate,
  type ActionRecipe,
  type CooldownReason,
  type PlatformManifest,
  type SuccessHook,
} from '../manifest'
import type {
  AccountState,
  ActionRequest,
  ActionType,
  ExecutionResult,
  MetricsRef,
  MetricsSnapshot,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformId,
  RiskResult,
} from '../types'

/**
 * Action types that CHANGE platform state (post a thing, follow someone,
 * upvote, edit profile). The finish validator and the preActionGate run
 * only for these — read-only / crawl actions skip both.
 */
const MUTATING_ACTION_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  'post',
  'comment',
  'reply',
  'send',
  'update_listing',
  'set_profile',
  'follow',
  'upvote',
  'engage',
])

/**
 * Appended to every browser goal so the agent knows how to surface
 * platform-imposed blocks in a structured way the adapter can act on.
 *
 * See docs/ACCOUNT_GROOMING.md §4.
 */
const BLOCK_DETECTION_ADDENDUM = `
IMPORTANT — if the platform refuses your write (rate limit, new-account block,
karma threshold, email verification, captcha, manual review), do NOT keep
retrying. Call finish with:
  success: false
  output: {
    blocked_reason: 'new_account' | 'karma_threshold' | 'rate_limit' |
                    'verify_email' | 'captcha' | 'manual_review' |
                    'no_target' | 'unknown',
    retry_after_hours?: number,   // only if the platform stated one
    evidence: '<verbatim text you saw>'
  }
  summary: '<one sentence>'
This is how the supervisor learns when to retry. Guessing is fine — use
'unknown' if you cannot tell.`

interface BlockedOutput {
  blocked_reason?: CooldownReason
  retry_after_hours?: number
  evidence?: string
}

const PROFILE_FIELD_MAP: Record<
  string,
  keyof NonNullable<AccountState['profile']>
> = {
  avatar: 'avatarSet',
  bio: 'bioSet',
  displayName: 'displayNameSet',
  website: 'websiteSet',
}

export class ManifestBrowserAdapter implements PlatformAdapter {
  readonly platform: PlatformId
  readonly capabilities: PlatformCapabilities

  constructor(public readonly manifest: PlatformManifest) {
    this.platform = manifest.id
    this.capabilities = manifest.capabilities
  }

  async validateAction(action: ActionRequest): Promise<RiskResult> {
    const recipe = this.manifest.actions[action.type] as
      | ActionRecipe
      | undefined

    // No recipe — adapter cannot execute this action type.
    if (!recipe) {
      return {
        ok: false,
        recommendation: 'block',
        reasons: [
          `${this.manifest.displayName} adapter has no recipe for action type "${action.type}". ` +
            `Add it to ${this.manifest.id}.manifest.ts.`,
        ],
      }
    }

    // Capability gates — keep these honest with the matrix.
    if (action.type === 'post' && !this.capabilities.canPost) {
      return { ok: false, recommendation: 'block', reasons: ['Adapter cannot post'] }
    }
    if (action.type === 'comment' && !this.capabilities.canComment) {
      return { ok: false, recommendation: 'block', reasons: ['Adapter cannot comment'] }
    }

    // Payload schema validation.
    const parsed = recipe.payloadSchema.safeParse(action.payload)
    if (!parsed.success) {
      return {
        ok: false,
        recommendation: 'block',
        reasons: parsed.error.errors.map(
          (e) => `${e.path.join('.')}: ${e.message}`,
        ),
      }
    }

    // Risk gate — recipe override > manifest default > capability cap.
    const recipeRisk =
      recipe.riskLevel ?? this.manifest.defaultRiskByActionType[action.type]
    const declaredRisk = action.riskLevel
    const effectiveRisk = Math.max(declaredRisk, recipeRisk ?? 0) as 0 | 1 | 2 | 3 | 4
    if (effectiveRisk > this.capabilities.maxAutonomousRiskLevel) {
      return {
        ok: false,
        recommendation: 'approve',
        reasons: [
          `Action risk level ${effectiveRisk} exceeds adapter max ${this.capabilities.maxAutonomousRiskLevel}`,
        ],
      }
    }
    return { ok: true, recommendation: 'execute', reasons: [] }
  }

  async executeAction(action: ActionRequest): Promise<ExecutionResult> {
    const recipe = this.manifest.actions[action.type] as
      | ActionRecipe
      | undefined
    if (!recipe) {
      return {
        status: 'failed',
        error: `${this.manifest.displayName} adapter has no recipe for "${action.type}"`,
      }
    }

    // Re-validate payload at execute time (validateAction may not have been
    // called in single-step paths like dev:run-action).
    const parsed = recipe.payloadSchema.safeParse(action.payload)
    if (!parsed.success) {
      return {
        status: 'failed',
        error: `Invalid payload: ${parsed.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ')}`,
      }
    }
    const payload = parsed.data as Record<string, unknown>

    const session = await loadBrowserSession(action.userId, this.platform)
    if (!session) {
      return {
        status: 'deferred',
        error: `No connected ${this.manifest.displayName} browser session. Run: pnpm connect:account ${this.platform}`,
      }
    }

    // Pre-action gate — check hard account-level preconditions BEFORE
    // spinning up the browser. For Reddit this is where we refuse mutating
    // actions on 0-karma / <3-day-old accounts rather than letting the
    // agent burn $0.01 + 60s to discover Reddit will shadow-remove the post.
    // Read-only action types bypass the gate entirely.
    if (this.manifest.preActionGate && MUTATING_ACTION_TYPES.has(action.type)) {
      const state = await loadAccountState(action.userId, this.platform)
      let verdict
      try {
        verdict = await this.manifest.preActionGate(action, state)
      } catch (err) {
        // A throwing gate should never block the run — gates are advisory.
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[${this.platform}] preActionGate threw: ${msg}`)
        verdict = { deferred: false } as const
      }
      if (verdict.deferred) {
        // Persist cooldown only for GLOBAL blocks — ones that mean "no
        // writes at all" regardless of action class. Action-specific
        // blocks (e.g. karma_threshold, which blocks post but not engage)
        // must NOT write a platform-wide cooldown, or they'd prevent the
        // warmup actions that EXIST to build karma from ever running.
        //
        // The gate itself runs cheaply (cached probe, ~ms) so re-evaluating
        // per call is fine. We only persist cooldowns that are truly
        // terminal for the account until something outside the loop
        // changes (time passes → new_account; user reconnects → manual_review).
        const globalBlock =
          verdict.reason === 'new_account' ||
          verdict.reason === 'manual_review' ||
          verdict.reason === 'verify_email'
        if (globalBlock) {
          await recordCooldown(
            action.userId,
            this.platform,
            verdict.cooldownUntil,
            verdict.reason,
            verdict.evidence,
          )
        }
        return {
          status: 'deferred',
          cooldownUntil: verdict.cooldownUntil,
          cooldownReason: verdict.reason,
          error: `${this.manifest.displayName} gate (${verdict.reason}): ${verdict.evidence}`,
        }
      }
    }

    // Resolve startUrl.
    const startUrl =
      typeof recipe.startUrl === 'function'
        ? recipe.startUrl(payload)
        : recipe.startUrl ?? this.manifest.baseUrl

    // Render goal template. Supports three shapes:
    //   - string:       `{{key}}` interpolation (common, static)
    //   - function:     synchronous render from payload
    //   - async fn:     render that pre-fetches external data (Reddit
    //                   engage uses this to resolve candidate posts via
    //                   the public JSON API before the browser launches)
    let renderedGoal: string
    if (typeof recipe.goalTemplate === 'string') {
      renderedGoal = renderTemplate(recipe.goalTemplate, payload)
    } else {
      renderedGoal = await recipe.goalTemplate(payload)
    }
    const goal = `${renderedGoal}\n${BLOCK_DETECTION_ADDENDUM}`

    return this.runWithCooldown(action, payload, recipe, {
      goal,
      startUrl,
      maxSteps: recipe.maxSteps ?? 30,
      maxWallclockMs: recipe.maxWallclockMs ?? 150_000,
    })
  }

  async collectMetrics(_ref: MetricsRef): Promise<MetricsSnapshot> {
    // Browser-driven metric collection deferred to milestone B4.
    return { platform: this.platform, capturedAt: new Date() }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private — shared executor + cooldown handling
  // ──────────────────────────────────────────────────────────────────────────

  private async runWithCooldown(
    action: ActionRequest,
    payload: Record<string, unknown>,
    recipe: ActionRecipe,
    opts: {
      goal: string
      startUrl: string
      maxSteps: number
      maxWallclockMs: number
    },
  ): Promise<ExecutionResult> {
    try {
      const result = await runBrowserTask({
        userId: action.userId,
        platform: this.platform,
        goal: opts.goal,
        startUrl: opts.startUrl,
        context: payload,
        systemAddendum: this.manifest.systemAddendum,
        maxSteps: opts.maxSteps,
        maxWallclockMs: opts.maxWallclockMs,
      })

      const baseRaw = {
        trajectorySteps: result.trajectory.length,
        costUsd: result.totalCostUsd,
        durationMs: result.totalDurationMs,
        trajectory: result.trajectory,
      }

      if (result.status === 'completed') {
        // Finish validator — catch the "agent returned success=true but
        // never actually performed the mutation" failure mode. Observed
        // repeatedly: agent finishes preflight, writes summary "Proceeding
        // to submit" + success=true, but output has no url. Stronger
        // prompting helps; this is the belt-and-braces machine check.
        //
        // Read-only actions (crawl) are exempt — they have no mutation
        // proof to look for.
        const proof = validateMutationProof(action, result.finalOutput)
        if (!proof.ok) {
          return {
            status: 'failed',
            error:
              `${this.manifest.displayName} agent returned success=true but ` +
              `finalOutput lacks proof: ${proof.reason}. ` +
              `Treating as failure — the action did not actually happen.`,
            raw: { ...baseRaw, unverifiedOutput: result.finalOutput },
          }
        }

        const success = await this.applySuccessHook(
          action,
          recipe.onSuccess ?? 'none',
          result,
        )
        return {
          status: 'ok',
          externalUrl: success.externalUrl,
          raw: { ...baseRaw, ...(success.raw ?? {}) },
        }
      }

      // Failure path — first prefer the agent's structured `blocked_reason`,
      // then fall back to regex-matching the manifest's blockedHints.
      const blocked = result.finalOutput as BlockedOutput | undefined
      const reasonFromAgent = blocked?.blocked_reason
      const evidence = blocked?.evidence ?? result.finalSummary ?? ''

      const cooldown = this.deriveCooldown(reasonFromAgent, evidence, blocked?.retry_after_hours)
      if (cooldown) {
        // Route subreddit_rules to per-sub cooldown so a single banned sub
        // does not lock the whole Reddit account. Requires payload.subreddit.
        const subreddit = (action.payload as { subreddit?: string }).subreddit
        if (cooldown.reason === 'subreddit_rules' && subreddit) {
          await recordSubredditCooldown(
            action.userId,
            this.platform,
            subreddit,
            cooldown.until,
            'subreddit_rules',
            evidence,
          )
        } else {
          await recordCooldown(
            action.userId,
            this.platform,
            cooldown.until,
            cooldown.reason,
            evidence,
          )
        }
        return {
          status: 'deferred',
          cooldownUntil: cooldown.until,
          cooldownReason: cooldown.reason,
          error: `${this.manifest.displayName} cooldown (${cooldown.reason})${
            subreddit && cooldown.reason === 'subreddit_rules' ? ` in r/${subreddit}` : ''
          }: ${evidence}`,
          raw: { ...baseRaw, blocked },
        }
      }

      return {
        status: 'failed',
        error: `Browser agent ${result.status}: ${result.finalSummary}`,
        raw: baseRaw,
      }
    } catch (err) {
      if (err instanceof NeedsReauthError) {
        return {
          status: 'deferred',
          error: `${this.manifest.displayName} session expired — user must reconnect`,
        }
      }
      return {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Map agent output / evidence text to a CooldownReason + expiry.
   *
   * Priority:
   *   1. agent's structured `blocked_reason` (most reliable)
   *   2. regex hits in manifest.blockedHints against `evidence`
   *   3. if neither matches: no cooldown (treat as plain failure)
   */
  private deriveCooldown(
    reasonFromAgent: CooldownReason | undefined,
    evidence: string,
    retryAfterHours: number | undefined,
  ): { reason: CooldownReason; until: Date } | null {
    if (reasonFromAgent) {
      const hours =
        retryAfterHours ?? this.manifest.defaultCooldownHoursByReason[reasonFromAgent]
      return {
        reason: reasonFromAgent,
        until: new Date(Date.now() + hours * 3600_000),
      }
    }

    if (!evidence) return null
    for (const hint of this.manifest.blockedHints) {
      if (hint.pattern.test(evidence)) {
        const hours =
          hint.retryHours ?? this.manifest.defaultCooldownHoursByReason[hint.reason]
        return {
          reason: hint.reason,
          until: new Date(Date.now() + hours * 3600_000),
        }
      }
    }
    return null
  }

  /**
   * Apply the recipe's onSuccess hook — bumping counters in account_state
   * so the warm-up planner sees progress next time.
   */
  private async applySuccessHook(
    action: ActionRequest,
    hook: SuccessHook,
    result: RunBrowserTaskResult,
  ): Promise<{ externalUrl?: string; raw?: Record<string, unknown> }> {
    const finalOutput = result.finalOutput ?? {}
    const externalUrl =
      (finalOutput.url as string | undefined) ??
      (finalOutput.externalUrl as string | undefined)

    switch (hook) {
      case 'none':
        return { externalUrl }

      case 'recordUpvote': {
        const upvoted = (finalOutput.upvoted as string[] | undefined) ?? []
        for (let i = 0; i < upvoted.length; i++) {
          await recordGroomingAction(action.userId, this.platform, 'upvote')
        }
        return { externalUrl, raw: { upvoted } }
      }

      case 'recordFollow': {
        const followed = (finalOutput.followed as string[] | undefined) ?? []
        for (let i = 0; i < followed.length; i++) {
          await recordGroomingAction(action.userId, this.platform, 'follow')
        }
        return { externalUrl, raw: { followed } }
      }

      case 'recordEngagement': {
        await recordGroomingAction(action.userId, this.platform, 'engage')
        return { externalUrl }
      }

      case 'recordProfileFields': {
        const updated = (finalOutput.updated as string[] | undefined) ?? []
        for (const field of updated) {
          const stateKey = PROFILE_FIELD_MAP[field]
          if (stateKey) {
            await recordProfileField(action.userId, this.platform, stateKey)
          }
        }
        return { externalUrl, raw: { updated } }
      }

      case 'recordSubredditPost':
      case 'recordSubredditComment': {
        const subreddit = (action.payload as { subreddit?: string }).subreddit
        if (!subreddit) return { externalUrl }
        const kind = hook === 'recordSubredditPost' ? 'post' : 'comment'
        await recordSubredditAction(action.userId, this.platform, subreddit, kind)

        // Cache rules summary so the planner can skip re-reading the sidebar.
        const rulesSummary = finalOutput.rulesSummary
        if (typeof rulesSummary === 'string' && rulesSummary.trim().length > 0) {
          await recordSubredditRules(action.userId, this.platform, subreddit, rulesSummary)
        }
        return { externalUrl, raw: { subreddit, kind } }
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Finish validator — "did the agent actually do what it claimed?"
// ────────────────────────────────────────────────────────────────────────────

type ProofResult = { ok: true } | { ok: false; reason: string }

/**
 * Check that the agent's `finalOutput` contains the proof artifacts the
 * action type requires. This is a defense against the agent returning
 * success=true prematurely — observed when it completes a preflight and
 * calls finish with summary "Proceeding to submit" instead of actually
 * submitting.
 *
 * The rules are intentionally conservative: we only require fields the
 * agent's own goal template already asks it to emit. If an output shape
 * changes, update both the goal template and this function.
 *
 * Read-only action types (crawl) and types we don't yet have hooks for
 * return ok=true — no proof required.
 */
function validateMutationProof(
  action: ActionRequest,
  finalOutput: Record<string, unknown> | undefined,
): ProofResult {
  if (!MUTATING_ACTION_TYPES.has(action.type)) return { ok: true }

  const o = finalOutput ?? {}

  switch (action.type) {
    case 'post':
    case 'comment':
    case 'reply': {
      // Must have a permalink to the created content. Callers generally
      // want `url`; accept `externalUrl` as a legacy alias.
      const url = (o.url ?? o.externalUrl) as unknown
      if (typeof url !== 'string' || url.length === 0) {
        return {
          ok: false,
          reason: `action ${action.type} requires output.url (permalink to the created content)`,
        }
      }
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, reason: `output.url is not a valid absolute URL: ${url}` }
      }
      return { ok: true }
    }

    case 'send': {
      // Direct messages don't always yield a URL; accept either url or a
      // truthy `sent` flag.
      const url = (o.url ?? o.externalUrl) as unknown
      if (typeof url === 'string' && url.length > 0) return { ok: true }
      if (o.sent === true) return { ok: true }
      return { ok: false, reason: `action send requires output.url or output.sent=true` }
    }

    case 'set_profile': {
      const updated = o.updated as unknown
      if (!Array.isArray(updated) || updated.length === 0) {
        return {
          ok: false,
          reason: `action set_profile requires output.updated (array of field names changed)`,
        }
      }
      return { ok: true }
    }

    case 'upvote': {
      const upvoted = o.upvoted as unknown
      if (!Array.isArray(upvoted) || upvoted.length === 0) {
        return {
          ok: false,
          reason: `action upvote requires output.upvoted (array of URLs actually upvoted)`,
        }
      }
      return { ok: true }
    }

    case 'follow': {
      const followed = o.followed as unknown
      if (!Array.isArray(followed) || followed.length === 0) {
        return {
          ok: false,
          reason: `action follow requires output.followed (array of handles actually followed)`,
        }
      }
      return { ok: true }
    }

    case 'engage': {
      // Engagement is a reply on someone else's post; expect the reply URL.
      const url = (o.url ?? o.externalUrl) as unknown
      if (typeof url !== 'string' || url.length === 0) {
        return {
          ok: false,
          reason: `action engage requires output.url (permalink to the reply)`,
        }
      }
      return { ok: true }
    }

    case 'update_listing': {
      // No hard proof required beyond a non-empty output; listing edits
      // often lack a stable permalink and the external_id is the listing
      // itself. Treat as pass — the onSuccess hook handles verification.
      return { ok: true }
    }

    default: {
      // Action types not in MUTATING_ACTION_TYPES already returned above.
      // This default keeps TS happy if a new mutating type is added without
      // updating this switch — fail OPEN (accept) so the system keeps
      // working; the loud path is preferred over a silent break.
      return { ok: true }
    }
  }
}
