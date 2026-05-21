/**
 * Diagnose a saved browser session.
 *
 * Usage:
 *   pnpm browser:check indie_hackers
 *
 * What it does:
 *   1. Loads the saved storageState from `browser_sessions`.
 *   2. Prints cookie names + domains so you can see what was actually captured.
 *   3. Launches a headful browser with that storageState.
 *   4. Navigates to a "logged-in-only" URL for the platform.
 *   5. Reports whether the page indicates a logged-in or logged-out state.
 *   6. Leaves the browser open for 30 seconds so you can inspect manually.
 *
 * If the session is bad you'll see in step 5 that we're redirected to /login.
 * Re-run `pnpm connect:account <platform>` and pay attention to the
 * "logged-in?" probe printed at the end before pressing Enter.
 */
import { localPlaywrightRuntime } from '@/lib/browser/runtime-local'
import { probeSession, PROBES } from '@/lib/browser/probes'
import { loadBrowserSession } from '@/lib/browser/session-store'
import { ensureDevUser } from '@/lib/dev-user'
import type { BrowserStorageState } from '@/lib/browser/types'

async function main() {
  const platform = process.argv[2]
  if (!platform) {
    console.error('Usage: pnpm browser:check <platform>')
    process.exit(1)
  }
  const probe = PROBES[platform]
  if (!probe) {
    console.error(
      `No probe configured for "${platform}". Available: ${Object.keys(PROBES).join(', ')}`,
    )
    process.exit(1)
  }

  void probe

  const userId = await ensureDevUser()
  const session = await loadBrowserSession(userId, platform)
  if (!session) {
    console.error(`No browser session for user=${userId} platform=${platform}.`)
    console.error(`Run: pnpm connect:account ${platform}`)
    process.exit(2)
  }

  const storageState = (session.storageState ?? null) as BrowserStorageState | null
  if (!storageState) {
    console.error('Session row exists but storage_state is null.')
    process.exit(2)
  }

  console.log(`\n=== session ${session.id} ===`)
  console.log(`platform        ${session.platform}`)
  console.log(`runtime         ${session.runtime}`)
  console.log(`status          ${session.status}`)
  console.log(`accountLabel    ${session.accountLabel ?? '(none)'}`)
  console.log(`createdAt       ${session.createdAt?.toISOString?.() ?? session.createdAt}`)
  console.log(`lastUsedAt      ${session.lastUsedAt?.toISOString?.() ?? session.lastUsedAt}`)

  console.log(`\n=== cookies (${storageState.cookies.length}) ===`)
  const byDomain = new Map<string, string[]>()
  for (const c of storageState.cookies) {
    const list = byDomain.get(c.domain) ?? []
    list.push(c.name)
    byDomain.set(c.domain, list)
  }
  for (const [domain, names] of [...byDomain.entries()].sort()) {
    console.log(`  ${domain.padEnd(30)}  ${names.join(', ')}`)
  }

  console.log(`\n=== origins / localStorage ===`)
  if (storageState.origins.length === 0) {
    console.log('  (empty)')
  } else {
    for (const o of storageState.origins) {
      console.log(`  ${o.origin}  (${o.localStorage.length} keys)`)
    }
  }

  console.log(`\n=== probing ${probe.loggedInUrl} ===`)
  const managed = await localPlaywrightRuntime.startSession({
    userId,
    platform,
    storageState,
    headful: true,
  })

  const verdict = await probeSession(managed.page, platform)
  if (!verdict) {
    console.log('No probe configured for this platform.')
  } else {
    console.log(`final URL       ${verdict.finalUrl}`)
    console.log(`title           ${verdict.title}`)
    console.log(`\nVerdict: ${verdict.verdict.toUpperCase()}`)
    console.log(`Hint:    ${verdict.hint}`)
    if (verdict.verdict === 'logged_out') {
      console.log(
        `\nAction:  re-run \`pnpm connect:account ${platform}\` and make sure the\n` +
          '         logged-in dashboard is fully loaded BEFORE you press Enter.',
      )
    }
  }

  console.log('\nLeaving browser open for 30s for manual inspection...')
  await new Promise((r) => setTimeout(r, 30_000))
  await managed.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('[browser-check] error:', err)
  process.exit(1)
})
