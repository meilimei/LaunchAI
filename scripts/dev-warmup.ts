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
 * This is now a THIN CLI WRAPPER over `runOneTick` (src/lib/warmup/run-one-tick.ts)
 * — the same function the Inngest scheduler / Fly worker call. It only adds
 * argument parsing, env-driven headful default, console rendering, and the
 * tmp/ trajectory dump. All planning + execution logic lives in runOneTick.
 *
 * No DB writes happen for the action history table — this is the same
 * smoke-test layer as dev:run-action. The grooming side-effects on
 * `browser_sessions.account_state` ARE persisted; that is the point.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDevUser } from '@/lib/dev-user'
import { runOneTick, type TickTrajectory } from '@/lib/warmup/run-one-tick'
import type { WarmupContext, WarmupPlan } from '@/lib/platforms/warmup-planner'
import type { PlatformId } from '@/lib/platforms/types'

// Show the browser by default — the agent operates a real account here.
if (process.env.BROWSER_HEADFUL === undefined) {
  process.env.BROWSER_HEADFUL = '1'
}

const VALID_PLATFORMS: PlatformId[] = [
  'x',
  'reddit', // Revived 2026-05-26. See reddit.manifest.ts header history.
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

/** Render an empty-step plan the same way the old inline logic did. */
function printNoSteps(plan: WarmupPlan): void {
  if (plan.blockedUntil && plan.blockedReason === 'rate_limit') {
    // dailyActionCap soft block — purely client-side, never persisted.
    console.log(
      `Daily action cap reached. Earliest next slot: ${plan.blockedUntil.toISOString()}.`,
    )
    console.log(
      '  Cap is enforced by warmup-planner.ts against the platform manifest\'s\n' +
        '  capabilities.dailyActionCap. No state change needed — wait it out\n' +
        '  or trim warmup.recentActionTimestamps in the dev DB to clear early.',
    )
  } else if (plan.blockedUntil) {
    console.log(
      `Plan blocked until ${plan.blockedUntil.toISOString()} ` +
        `(reason=${plan.blockedReason ?? 'unknown'}).`,
    )
  } else {
    console.log('No grooming steps needed — account is posting_ready.')
    console.log('Next: enqueue an actual content action (post / comment).')
  }
}

async function main() {
  const { platform, contextPath, execute } = parseArgs()
  const userId = await ensureDevUser()
  const context = loadContext(contextPath)

  console.log(`[dev-warmup] platform=${platform} userId=${userId}`)
  console.log(`[dev-warmup] context=${contextPath}`)

  // CLI-only trajectory sink: dump the full execution result to tmp/.
  let trajectoryFile: string | undefined
  const onTrajectory = (record: TickTrajectory) => {
    const dir = path.resolve(process.cwd(), 'tmp')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    trajectoryFile = path.join(dir, `dev-warmup-${stamp}.json`)
    fs.writeFileSync(trajectoryFile, JSON.stringify(record.result, null, 2), 'utf8')
  }

  const tick = await runOneTick({ userId, platform, context, execute, onTrajectory })

  // ── current account state ──────────────────────────────────────────────
  const state = tick.state
  console.log(`\n=== current account state ===`)
  console.log(`stage:        ${tick.stage}`)
  console.log(`profile:      ${JSON.stringify(state?.profile ?? {})}`)
  console.log(`warmup:       ${JSON.stringify(state?.warmup ?? {})}`)
  if (state?.cooldownUntil) {
    console.log(`cooldown:     until=${state.cooldownUntil} reason=${state.cooldownReason}`)
    if (state.cooldownEvidence) console.log(`evidence:     ${state.cooldownEvidence}`)
  }

  if (tick.outcome === 'cooldown') {
    console.log(`\n[dev-warmup] account is in cooldown — refusing to plan or execute.`)
    process.exit(0)
  }

  // ── plan ────────────────────────────────────────────────────────────────
  const plan = tick.plan
  console.log(`\n=== plan ===`)
  console.log(`derived stage: ${plan.stage}`)
  if (plan.steps.length === 0) {
    printNoSteps(plan)
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

  // ── execution ─────────────────────────────────────────────────────────--
  const executed = tick.executed!
  console.log(`\n[dev-warmup] executing step 1: ${executed.action.type}`)

  if (tick.outcome === 'validation_failed') {
    console.error(`[dev-warmup] validation FAILED: ${executed.validation.recommendation}`)
    for (const r of executed.validation.reasons) console.error(`  - ${r}`)
    process.exit(2)
  }

  const result = executed.result!
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
  if (trajectoryFile) console.log(`trajectory:    ${trajectoryFile}`)

  // ── next plan (after this step) ──────────────────────────────────────────
  const nextPlan = tick.nextPlan!
  console.log(`\n=== next plan (after this step) ===`)
  console.log(`derived stage: ${nextPlan.stage}`)
  if (nextPlan.blockedUntil && nextPlan.blockedReason === 'rate_limit') {
    console.log(
      `Daily action cap reached. Earliest next slot: ${nextPlan.blockedUntil.toISOString()}.`,
    )
  } else if (nextPlan.blockedUntil) {
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
      console.log(`  [${i + 1}] ${step.action.type.padEnd(12)}  ${step.reason}`)
    }
  }

  if (result.status === 'ok') process.exit(0)
  process.exit(result.status === 'deferred' ? 3 : 4)
}

main().catch((err) => {
  console.error('[dev-warmup] error:', err)
  process.exit(1)
})
