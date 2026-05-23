/**
 * Mosaiq Cloud runtime smoke test.
 *
 * Verifies the BROWSER_RUNTIME=mosaiq path end-to-end, bypassing the full
 * Next.js / Clerk / queue stack. Talks straight to:
 *
 *   getBrowserRuntime() → mosaiqCloudRuntime
 *     → MosaiqCloudClient.createSession()
 *     → cloud-runtime REST (POST /v1/sessions)
 *     → cloud-runtime WS upgrade proxy (chromium.connectOverCDP)
 *     → browser-pod (spawned chromium with persona launch flags)
 *     → session.injectInto(ctx) (persona JS-level addInitScript)
 *
 * Then asserts:
 *   - runtime tag is 'mosaiq'
 *   - navigator.* surface in the live page reflects the persona, not raw chromium
 *   - saveStorageState() returns a cookies array
 *   - close() releases the pod (caller must verify pool.busy == 0 separately)
 *
 * Run:
 *   pnpm dev:mosaiq-smoke
 *
 * Pre-reqs:
 *   - Mosaiq pod running on POD_ADDRS (default http://127.0.0.1:9222)
 *   - cloud-runtime running on MOSAIQ_API_URL (default http://127.0.0.1:8787)
 *   - .env.local has MOSAIQ_API_KEY / MOSAIQ_PROJECT_ID / MOSAIQ_DEFAULT_PERSONA_ID set
 */
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

function check(label: string, ok: boolean, detail: string): void {
  const sym = ok ? '✅' : '❌'
  console.log(`  ${sym} ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) process.exitCode = 1
}

async function main() {
  const t0 = Date.now()
  const ts = (msg: string) => console.log(`[+${String(Date.now() - t0).padStart(5)}ms] ${msg}`)

  ts(`BROWSER_RUNTIME=${process.env.BROWSER_RUNTIME ?? '(unset, default local)'}`)
  ts(`MOSAIQ_API_URL=${process.env.MOSAIQ_API_URL ?? '(unset)'}`)
  ts(`MOSAIQ_PROJECT_ID=${process.env.MOSAIQ_PROJECT_ID ?? '(unset)'}`)
  ts(`MOSAIQ_DEFAULT_PERSONA_ID=${process.env.MOSAIQ_DEFAULT_PERSONA_ID ?? '(unset)'}`)

  const runtime = getBrowserRuntime()
  ts(`runtime.kind = ${runtime.kind}`)
  if (runtime.kind !== 'mosaiq') {
    console.error(
      `\n❌ Expected runtime.kind === 'mosaiq', got '${runtime.kind}'.\n` +
        `   Set BROWSER_RUNTIME=mosaiq in .env.local before running this script.`,
    )
    process.exit(2)
  }

  ts('startSession({ userId: mosaiq-smoke, platform: reddit, startUrl: about:blank })')
  const session = await runtime.startSession({
    userId: 'mosaiq-smoke-user',
    platform: 'reddit',
    startUrl: 'about:blank',
  })
  ts(`session.id = ${session.id}  runtime = ${session.runtime}`)
  check("session.runtime === 'mosaiq'", session.runtime === 'mosaiq', `got ${session.runtime}`)
  check('session.id starts with mosaiq_', session.id.startsWith('mosaiq_'), session.id)

  ts('navigator/* observation in live page')
  const observed = (await session.page.evaluate(() => {
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
  })) as NavigatorObservation
  console.log(observed)

  // win11-chrome-us persona expected surface (matches Mosaiq e2e-smoke.mjs assertions)
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

  ts('saveStorageState()')
  const state = await session.saveStorageState()
  ts(`state.cookies.length = ${state.cookies?.length ?? 0}`)
  check('state.cookies is array', Array.isArray(state.cookies), `got ${typeof state.cookies}`)

  ts('session.close()')
  await session.close()
  ts('done')

  if (process.exitCode === 1) {
    console.log('\n❌ SOME CHECKS FAILED')
  } else {
    console.log(`\n🎉 LaunchAI ↔ Mosaiq Cloud smoke PASSED in ${(Date.now() - t0) / 1000}s`)
  }
}

main().catch((err) => {
  console.error('\n❌ FATAL:', err)
  process.exit(2)
})
