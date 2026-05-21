/**
 * Run one cycle of the warm-up planner for a connected account.
 *
 * Usage:
 *   pnpm dev:warmup <platform> --context <json-path>            # plan only
 *   pnpm dev:warmup <platform> --context <json-path> --execute  # plan + run #1
 *
 * The context JSON describes the user's product (see
 * scripts/fixtures/warmup-context.json). In the supervisor this would come
 * from the campaign row.
 *
 * Output:
 *   - Current AccountState
 *   - Derived stage
 *   - Next planned actions (priority order, with reasons)
 *   - If --execute: dispatches the top action via the platform adapter,
 *     prints the result + trajectory, and shows what the next plan looks
 *     like after the new state is persisted.
 *
 * No DB writes happen for the action history table — this is the same
 * smoke-test layer as dev:run-action. The grooming side-effects on
 * `browser_sessions.account_state` ARE persisted; that is the point.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDevUser } from '@/lib/dev-user'
import { loadAccountState, deriveStage, isInCooldown } from '@/lib/browser/account-state'
import { getPlatformAdapter } from '@/lib/platforms/registry'
import { planWarmup, type WarmupContext } from '@/lib/platforms/warmup-planner'
import type { ActionRequest, PlatformId } from '@/lib/platforms/types'

// Show the browser by default — the agent operates a real account here.
if (process.env.BROWSER_HEADFUL === undefined) {
  process.env.BROWSER_HEADFUL = '1'
}

const VALID_PLATFORMS: PlatformId[] = [
  'x',
  // 'reddit', // Deprecated for autonomous posting 2026-05-02. See reddit.manifest.ts.
  'product_hunt',
  'hacker_news',
  'indie_hackers',
  'cws',
  'blog',
]

interface ParsedArgs {
  platform: PlatformId
  contextPath: string
  execute: boolean
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2)
  if (args.length < 1) {
    console.error(
      'Usage: pnpm dev:warmup <platform> [--context <path>] [--execute]\n' +
        `  platforms: ${VALID_PLATFORMS.join(', ')}\n` +
        '  default --context: scripts/fixtures/warmup-context.json',
    )
    process.exit(1)
  }
  const platform = args[0] as PlatformId
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(`Unknown platform: ${platform}`)
  }
  let contextPath = path.resolve(
    process.cwd(),
    'scripts/fixtures/warmup-context.json',
  )
  let execute = false
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '--context' && args[i + 1]) contextPath = path.resolve(process.cwd(), args[++i]!)
    else if (a === '--execute') execute = true
  }
  return { platform, contextPath, execute }
}

function loadContext(p: string): WarmupContext {
  if (!fs.existsSync(p)) throw new Error(`context file not found: ${p}`)
  const raw = fs.readFileSync(p, 'utf8')
  return JSON.parse(raw) as WarmupContext
}

async function main() {
  const { platform, contextPath, execute } = parseArgs()
  const userId = await ensureDevUser()
  const ctx = loadContext(contextPath)

  console.log(`[dev-warmup] platform=${platform} userId=${userId}`)
  console.log(`[dev-warmup] context=${contextPath}`)

  const state = await loadAccountState(userId, platform)
  const stage = deriveStage(state)
  console.log(`\n=== current account state ===`)
  console.log(`stage:        ${stage}`)
  console.log(`profile:      ${JSON.stringify(state?.profile ?? {})}`)
  console.log(`warmup:       ${JSON.stringify(state?.warmup ?? {})}`)
  if (state?.cooldownUntil) {
    console.log(`cooldown:     until=${state.cooldownUntil} reason=${state.cooldownReason}`)
    if (state.cooldownEvidence) console.log(`evidence:     ${state.cooldownEvidence}`)
  }

  if (isInCooldown(state)) {
    console.log(
      `\n[dev-warmup] account is in cooldown — refusing to plan or execute.`,
    )
    process.exit(0)
  }

  const plan = planWarmup(platform, state, ctx)
  console.log(`\n=== plan ===`)
  console.log(`derived stage: ${plan.stage}`)
  if (plan.steps.length === 0) {
    console.log('No grooming steps needed — account is posting_ready.')
    console.log('Next: enqueue an actual content action (post / comment).')
    process.exit(0)
  }
  for (const [i, step] of plan.steps.entries()) {
    console.log(
      `  [${i + 1}] type=${step.action.type.padEnd(12)} risk=${step.action.riskLevel}  ${step.reason}`,
    )
    console.log(`       payload: ${JSON.stringify(step.action.payload)}`)
  }

  if (!execute) {
    console.log(
      `\n[dev-warmup] plan-only mode. Re-run with --execute to dispatch step 1.`,
    )
    process.exit(0)
  }

  // Execute step 1 only — re-plan after each action.
  const top = plan.steps[0]!
  console.log(`\n[dev-warmup] executing step 1: ${top.action.type}`)
  const adapter = getPlatformAdapter(platform)
  const action: ActionRequest = { ...top.action, userId }

  const validation = await adapter.validateAction(action)
  if (!validation.ok) {
    console.error(`[dev-warmup] validation FAILED: ${validation.recommendation}`)
    for (const r of validation.reasons) console.error(`  - ${r}`)
    process.exit(2)
  }

  const result = await adapter.executeAction(action)
  console.log(`\n=== result ===`)
  console.log(`status:        ${result.status}`)
  if (result.error) console.log(`error:         ${result.error}`)
  if (result.externalUrl) console.log(`externalUrl:   ${result.externalUrl}`)
  if (result.cooldownUntil)
    console.log(
      `cooldownUntil: ${result.cooldownUntil.toISOString()} reason=${result.cooldownReason}`,
    )

  const raw = result.raw as
    | { trajectory?: unknown[]; trajectorySteps?: number; costUsd?: number }
    | undefined
  if (raw?.trajectorySteps !== undefined) {
    console.log(`steps:         ${raw.trajectorySteps}`)
  }
  if (raw?.costUsd !== undefined) console.log(`costUsd:       ${raw.costUsd.toFixed(5)}`)

  if (raw?.trajectory) {
    const dir = path.resolve(process.cwd(), 'tmp')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, `dev-warmup-${stamp}.json`)
    fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8')
    console.log(`trajectory:    ${file}`)
  }

  // Show what the planner thinks next, post-execution.
  const nextState = await loadAccountState(userId, platform)
  const nextPlan = planWarmup(platform, nextState, ctx)
  console.log(`\n=== next plan (after this step) ===`)
  console.log(`derived stage: ${nextPlan.stage}`)
  if (nextPlan.blockedUntil) {
    // Cooldown short-circuit — empty steps mean "wait", not "advance".
    console.log(
      `Account is blocked until ${nextPlan.blockedUntil.toISOString()} ` +
        `(reason=${nextPlan.blockedReason ?? 'unknown'}). ` +
        `Run \`pnpm dev:clear-cooldown ${platform}\` to override for dev.`,
    )
  } else if (nextPlan.steps.length === 0) {
    console.log('No grooming steps needed — account is posting_ready.')
    console.log('Next: enqueue an actual content action (post / comment).')
  } else {
    for (const [i, step] of nextPlan.steps.slice(0, 3).entries()) {
      console.log(
        `  [${i + 1}] ${step.action.type.padEnd(12)}  ${step.reason}`,
      )
    }
  }

  if (result.status === 'ok') process.exit(0)
  process.exit(result.status === 'deferred' ? 3 : 4)
}

main().catch((err) => {
  console.error('[dev-warmup] error:', err)
  process.exit(1)
})
