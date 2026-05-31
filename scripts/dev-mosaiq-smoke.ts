/**
 * Mosaiq Cloud runtime smoke test.
 *
 * Verifies the BROWSER_RUNTIME=mosaiq path end-to-end, bypassing the full
 * Next.js / Clerk / queue stack. Runs TWO grooming cycles to prove phase 11.5
 * keepAlive + sticky rejoin: cycle-1 cold start, disconnect (pod stays alive),
 * cycle-2 rejoin same stickyKey without cold pod spawn.
 *
 * Run:
 *   pnpm dev:mosaiq-smoke
 *
 * Pre-reqs:
 *   - cloud-runtime running on MOSAIQ_API_URL (default http://127.0.0.1:8787)
 *   - .env.local has MOSAIQ_API_KEY / MOSAIQ_PROJECT_ID / MOSAIQ_DEFAULT_PERSONA_ID
 *   - BROWSER_RUNTIME=mosaiq
 */
import { MosaiqCloudClient } from '@runova/cloud-sdk'

import { getBrowserRuntime } from '@/lib/browser/runtime'

interface NavigatorObservation {
  userAgent: string
  platform: string
  languages: readonly string[]
  language: string
  hardwareConcurrency: number
  deviceMemory: number | undefined
  maxTouchPoints: number
  screenW: number
  screenH: number
  devicePixelRatio: number
  intlTimezone: string
}

const SMOKE_USER = 'mosaiq-smoke-user'
const SMOKE_PLATFORM = 'reddit'

function check(label: string, ok: boolean, detail: string): void {
  const sym = ok ? '✅' : '❌'
  console.log(`  ${sym} ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) process.exitCode = 1
}

async function observeNavigator(page: {
  evaluate: <T>(fn: () => T) => Promise<T>
}): Promise<NavigatorObservation> {
  return page.evaluate(() => {
    const nav = navigator as Navigator & { deviceMemory?: number }
    return {
      userAgent: nav.userAgent,
      platform: nav.platform,
      languages: Array.from(nav.languages ?? []),
      language: nav.language,
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory,
      maxTouchPoints: nav.maxTouchPoints,
      screenW: window.screen.width,
      screenH: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      intlTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  }) as Promise<NavigatorObservation>
}

function assertPersonaSurface(observed: NavigatorObservation): void {
  check('navigator.platform == "Win32"', observed.platform === 'Win32', observed.platform)
  check(
    'navigator.languages == ["en-US","en"]',
    JSON.stringify(observed.languages) === '["en-US","en"]',
    JSON.stringify(observed.languages),
  )
  check('navigator.language == "en-US"', observed.language === 'en-US', observed.language)
  check(
    'navigator.hardwareConcurrency == 8',
    observed.hardwareConcurrency === 8,
    String(observed.hardwareConcurrency),
  )
  check(
    'navigator.deviceMemory == 8',
    observed.deviceMemory === 8,
    String(observed.deviceMemory),
  )
  check(
    'navigator.maxTouchPoints == 0',
    observed.maxTouchPoints === 0,
    String(observed.maxTouchPoints),
  )
  check('screen.width == 1920', observed.screenW === 1920, String(observed.screenW))
  check('screen.height == 1080', observed.screenH === 1080, String(observed.screenH))
  check(
    'devicePixelRatio == 1',
    observed.devicePixelRatio === 1,
    String(observed.devicePixelRatio),
  )
  check(
    'Intl.timezone == America/New_York',
    observed.intlTimezone === 'America/New_York',
    observed.intlTimezone,
  )
  check(
    'userAgent contains Windows NT 10.0',
    observed.userAgent.includes('Windows NT 10.0'),
    observed.userAgent,
  )
  check(
    'userAgent contains Chrome/130.',
    observed.userAgent.includes('Chrome/130.'),
    observed.userAgent,
  )
}

async function runCycle(
  cycle: 1 | 2,
  t0: number,
  ts: (msg: string) => void,
): Promise<{ connectMs: number }> {
  const runtime = getBrowserRuntime()
  const tConnect = Date.now()
  ts(`[cycle ${cycle}] startSession({ userId: ${SMOKE_USER}, platform: ${SMOKE_PLATFORM} })`)
  const session = await runtime.startSession({
    userId: SMOKE_USER,
    platform: SMOKE_PLATFORM,
    startUrl: 'about:blank',
  })
  const connectMs = Date.now() - tConnect
  ts(`[cycle ${cycle}] session.id = ${session.id}  connectMs = ${connectMs}`)
  check("session.runtime === 'mosaiq'", session.runtime === 'mosaiq', `got ${session.runtime}`)
  check('session.id starts with mosaiq_', session.id.startsWith('mosaiq_'), session.id)

  const observed = await observeNavigator(session.page)
  console.log(observed)
  assertPersonaSurface(observed)

  const state = await session.saveStorageState()
  check('state.cookies is array', Array.isArray(state.cookies), `got ${typeof state.cookies}`)

  ts(`[cycle ${cycle}] session.close() (keepAlive disconnect — pod stays alive)`)
  await session.close()
  ts(`[cycle ${cycle}] done (+${Date.now() - t0}ms total)`)
  return { connectMs }
}

async function main() {
  const t0 = Date.now()
  const ts = (msg: string) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms] ${msg}`)

  ts(`BROWSER_RUNTIME=${process.env.BROWSER_RUNTIME ?? '(unset, default local)'}`)
  ts(`MOSAIQ_API_URL=${process.env.MOSAIQ_API_URL ?? '(unset)'}`)
  ts(`MOSAIQ_PROJECT_ID=${process.env.MOSAIQ_PROJECT_ID ?? '(unset)'}`)
  ts(`MOSAIQ_DEFAULT_PERSONA_ID=${process.env.MOSAIQ_DEFAULT_PERSONA_ID ?? '(unset)'}`)

  const runtime = getBrowserRuntime()
  if (runtime.kind !== 'mosaiq') {
    console.error(
      `\n❌ Expected runtime.kind === 'mosaiq', got '${runtime.kind}'.\n` +
        `   Set BROWSER_RUNTIME=mosaiq in .env.local before running this script.`,
    )
    process.exit(2)
  }

  const client = new MosaiqCloudClient({
    apiUrl: process.env.MOSAIQ_API_URL ?? 'http://127.0.0.1:8787',
    apiKey: process.env.MOSAIQ_API_KEY!,
    projectId: process.env.MOSAIQ_PROJECT_ID ?? 'proj_launchai',
  })

  const cycle1 = await runCycle(1, t0, ts)

  // After cycle-1 disconnect, keepAlive session should still be live on control plane.
  const liveAfterCycle1 = await client.listSessions({ status: 'live' })
  ts(`live sessions after cycle-1: ${liveAfterCycle1.length}`)
  check(
    'keepAlive session still live after disconnect',
    liveAfterCycle1.length >= 1,
    `count=${liveAfterCycle1.length}`,
  )

  const cycle2 = await runCycle(2, t0, ts)

  // Rejoin should be materially faster than cold start (no new pod acquire).
  // Local docker cold start is often 15-40s; rejoin is typically <10s.
  check(
    'cycle-2 connect faster than cycle-1 (sticky rejoin)',
    cycle2.connectMs < cycle1.connectMs,
    `cycle1=${cycle1.connectMs}ms cycle2=${cycle2.connectMs}ms`,
  )

  if (process.exitCode === 1) {
    console.log('\n❌ SOME CHECKS FAILED')
  } else {
    console.log(
      `\n🎉 LaunchAI ↔ Mosaiq Cloud smoke PASSED (2 cycles, rejoin) in ${(Date.now() - t0) / 1000}s`,
    )
  }
}

main().catch((err) => {
  console.error('\n❌ FATAL:', err)
  process.exit(2)
})
