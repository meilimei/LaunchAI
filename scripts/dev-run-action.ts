/**
 * Manually run one platform action end-to-end.
 *
 * Usage:
 *   pnpm dev:run-action <platform> <type> --payload-file <path>
 *   pnpm dev:run-action <platform> <type> --payload <json>
 *
 * Recommended on Windows / PowerShell: --payload-file. Inline --payload
 * gets shredded by PowerShell's quoting + pnpm's argument forwarding.
 *
 * Examples:
 *   pnpm dev:run-action indie_hackers post    --payload-file scripts/fixtures/ih-post.json
 *   pnpm dev:run-action indie_hackers comment --payload-file scripts/fixtures/ih-comment.json
 *
 * Prereqs:
 *   1. `pnpm db:apply`            (applies browser_sessions table)
 *   2. `pnpm connect:account indie_hackers`  (one-time login)
 *
 * What it does:
 *   - Loads the dev user.
 *   - Creates a synthetic ActionRequest (no campaign/task row needed).
 *   - Calls adapter.validateAction → adapter.executeAction.
 *   - Prints the result and the trajectory cost.
 *
 * No DB writes happen for the action itself — this is a smoke test, not
 * a campaign run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDevUser } from '@/lib/dev-user'
import { getPlatformAdapter } from '@/lib/platforms/registry'
import { renderTemplate, type ActionRecipe } from '@/lib/platforms/manifest'
import { getManifest } from '@/lib/platforms/manifests'
import type { ActionRequest, PlatformId, RiskLevel } from '@/lib/platforms/types'

// Smoke-test ergonomics: show the browser unless the user explicitly opted out.
if (process.env.BROWSER_HEADFUL === undefined) {
  process.env.BROWSER_HEADFUL = '1'
}

interface ParsedArgs {
  platform: PlatformId
  type: ActionRequest['type']
  payload: Record<string, unknown>
  riskLevel: RiskLevel
  execute: boolean
}

const VALID_PLATFORMS: PlatformId[] = [
  'x',
  'reddit',
  'product_hunt',
  'hacker_news',
  'indie_hackers',
  'cws',
  'blog',
]
const VALID_TYPES: ActionRequest['type'][] = [
  'post',
  'comment',
  'reply',
  'update_listing',
  'send',
  'crawl',
]

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2)
  if (args.length < 2) {
    console.error(
      'Usage:\n' +
        '  pnpm dev:run-action <platform> <type> --payload-file <path> [--execute]\n' +
        '  pnpm dev:run-action <platform> <type> --payload <json>      (POSIX shells only)\n' +
        '\n' +
        '  Default mode is plan-only: validate payload, render the goal template, exit.\n' +
        '  Pass --execute to actually run the browser agent.\n' +
        '\n' +
        `  platforms: ${VALID_PLATFORMS.join(', ')}\n` +
        `  types:     ${VALID_TYPES.join(', ')}`,
    )
    process.exit(1)
  }
  const platform = args[0] as PlatformId
  const type = args[1] as ActionRequest['type']

  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(`Unknown platform: ${platform}`)
  }
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Unknown action type: ${type}`)
  }

  let payload: Record<string, unknown> | undefined
  let riskLevel: RiskLevel = 2
  let execute = false

  for (let i = 2; i < args.length; i++) {
    const a = args[i]
    if (a === '--payload' && args[i + 1]) {
      try {
        payload = JSON.parse(args[++i]!)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(
          `--payload is not valid JSON (${msg}). On Windows/PowerShell prefer --payload-file <path>.`,
        )
      }
    } else if (a === '--payload-file' && args[i + 1]) {
      const p = path.resolve(process.cwd(), args[++i]!)
      if (!fs.existsSync(p)) throw new Error(`payload file not found: ${p}`)
      const raw = fs.readFileSync(p, 'utf8')
      try {
        payload = JSON.parse(raw)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`payload file ${p} is not valid JSON: ${msg}`)
      }
    } else if (a === '--risk' && args[i + 1]) {
      const n = Number.parseInt(args[++i]!, 10)
      if (n < 0 || n > 4) throw new Error('risk must be 0-4')
      riskLevel = n as RiskLevel
    } else if (a === '--execute') {
      execute = true
    }
  }

  if (!payload) {
    throw new Error('Missing payload. Pass --payload-file <path> or --payload <json>.')
  }
  return { platform, type, payload, riskLevel, execute }
}

async function main() {
  const { platform, type, payload, riskLevel, execute } = parseArgs()
  const userId = await ensureDevUser()

  const adapter = getPlatformAdapter(platform)
  console.log(
    `[dev-run-action] platform=${platform} type=${type} executionMode=${adapter.capabilities.executionMode}`,
  )

  const request: ActionRequest = {
    userId,
    campaignId: 'dev-run-action',
    type,
    riskLevel,
    payload,
  }

  console.log(`[dev-run-action] validating...`)
  const validation = await adapter.validateAction(request)
  if (!validation.ok) {
    console.error(`[dev-run-action] validation FAILED: ${validation.recommendation}`)
    for (const r of validation.reasons) console.error(`  - ${r}`)
    process.exit(2)
  }
  console.log('[dev-run-action] validation OK')

  // Plan-only path — render the goal template so the user can review what
  // would be sent to the agent before any browser action runs.
  const manifest = getManifest(platform)
  const recipe = manifest.actions[type] as ActionRecipe | undefined
  if (recipe) {
    // goalTemplate may be string, sync fn, or async fn — mirror the
    // resolution the adapter does in executeAction.
    const renderedGoal =
      typeof recipe.goalTemplate === 'string'
        ? renderTemplate(recipe.goalTemplate, payload)
        : await recipe.goalTemplate(payload)
    const startUrl =
      typeof recipe.startUrl === 'function'
        ? recipe.startUrl(payload)
        : recipe.startUrl ?? manifest.baseUrl
    console.log('\n=== rendered goal (what the agent will see) ===')
    console.log(`startUrl:        ${startUrl}`)
    console.log(`maxSteps:        ${recipe.maxSteps ?? 30}`)
    console.log(`maxWallclockMs:  ${recipe.maxWallclockMs ?? 150_000}`)
    console.log(`onSuccess hook:  ${recipe.onSuccess ?? 'none'}`)
    console.log('\n--- goal text ---')
    console.log(renderedGoal)
    console.log('--- end goal text ---')
  }

  if (!execute) {
    console.log(
      '\n[dev-run-action] plan-only mode (default). Re-run with --execute to dispatch the action.',
    )
    process.exit(0)
  }

  console.log(`\n[dev-run-action] --execute set, dispatching browser agent...`)
  const result = await adapter.executeAction(request)

  // Pull out the trajectory before printing the result, so we can show it
  // in a readable form rather than as a giant blob inside JSON.stringify.
  const raw = (result.raw ?? {}) as {
    trajectory?: TrajectoryStep[]
    trajectorySteps?: number
    costUsd?: number
    durationMs?: number
  }
  const trajectory = raw.trajectory ?? []

  console.log('\n[dev-run-action] result:')
  console.log(
    JSON.stringify(
      {
        status: result.status,
        error: result.error,
        externalUrl: result.externalUrl,
        trajectorySteps: raw.trajectorySteps,
        costUsd: raw.costUsd,
        durationMs: raw.durationMs,
      },
      null,
      2,
    ),
  )

  if (trajectory.length > 0) {
    console.log(`\n[dev-run-action] trajectory (${trajectory.length} steps):`)
    for (const step of trajectory) {
      const tc = step.toolCall as Record<string, unknown>
      const tool = String(tc.tool ?? '?')
      const reason = typeof tc.reason === 'string' ? tc.reason : ''
      const detail = describeToolCall(tc)
      const ok = step.result?.ok ? 'OK ' : 'ERR'
      const obs = (step.result?.observation ?? '').replace(/\s+/g, ' ').slice(0, 140)
      console.log(
        `  [${String(step.index).padStart(2, '0')}] ${ok} ${tool.padEnd(14)} ${detail}`,
      )
      if (reason) console.log(`        reason: ${reason}`)
      if (obs) console.log(`        obs:    ${obs}`)
    }

    const dir = path.resolve(process.cwd(), 'tmp')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, `dev-run-action-${stamp}.json`)
    fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8')
    console.log(`\n[dev-run-action] full result written to ${file}`)
  }

  if (result.status === 'ok') {
    process.exit(0)
  }
  process.exit(result.status === 'deferred' ? 3 : 4)
}

interface TrajectoryStep {
  index: number
  toolCall: Record<string, unknown>
  result?: { ok?: boolean; observation?: string; error?: string }
  durationMs?: number
  costUsd?: number
}

function describeToolCall(tc: Record<string, unknown>): string {
  const tool = String(tc.tool ?? '')
  switch (tool) {
    case 'navigate':
      return `→ ${tc.url}`
    case 'click':
      return `${tc.selector}`
    case 'type':
      return `${tc.selector} ← "${String(tc.text ?? '').slice(0, 40)}${tc.submit ? '⏎' : ''}"`
    case 'press':
      return `${tc.key}`
    case 'wait_for':
      return `${tc.selector}`
    case 'extract_text':
      return tc.selector ? String(tc.selector) : '(body)'
    case 'describe_page':
      return ''
    case 'finish':
      return `success=${tc.success} "${String(tc.summary ?? '').slice(0, 80)}"`
    default:
      return JSON.stringify(tc).slice(0, 80)
  }
}

main().catch((err) => {
  console.error('[dev-run-action] error:', err)
  process.exit(1)
})
