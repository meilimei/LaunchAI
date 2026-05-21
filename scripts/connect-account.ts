/**
 * Connect a real social account to LaunchAI by hand, once.
 *
 * Usage:
 *   pnpm connect:account reddit
 *   pnpm connect:account x          --start https://x.com/login
 *   pnpm connect:account indie_hackers
 *
 * What it does:
 *   1. Launches a *headful* Chromium via the local Playwright runtime.
 *   2. Navigates to the platform login page.
 *   3. The human (you) logs in manually — including 2FA / CAPTCHA.
 *   4. When you're done, press Enter in this terminal.
 *   5. The script captures storageState (cookies + localStorage) and
 *      upserts it into `browser_sessions` for the dev user.
 *
 * After this, the campaign worker can operate the account autonomously
 * via runBrowserTask() until the cookies expire.
 *
 * Auto-registration is intentionally NOT supported — see
 * docs/BROWSER_AUTONOMY.md §2.
 */
import readline from 'node:readline'
import { localPlaywrightRuntime } from '@/lib/browser/runtime-local'
import { probeSession, PROBES } from '@/lib/browser/probes'
import { upsertBrowserSession } from '@/lib/browser/session-store'
import { ensureDevUser } from '@/lib/dev-user'

const DEFAULT_LOGIN_URLS: Record<string, string> = {
  reddit: 'https://www.reddit.com/login/',
  x: 'https://x.com/i/flow/login',
  twitter: 'https://x.com/i/flow/login',
  product_hunt: 'https://www.producthunt.com/sessions/new',
  hacker_news: 'https://news.ycombinator.com/login',
  indie_hackers: 'https://www.indiehackers.com/sign-in',
  cws: 'https://chrome.google.com/webstore/devconsole/',
}

function parseArgs(): { platform: string; startUrl: string; label?: string } {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Usage: pnpm connect:account <platform> [--start <url>] [--label <handle>]')
    process.exit(1)
  }
  const platform = args[0]!
  let startUrl = DEFAULT_LOGIN_URLS[platform]
  let label: string | undefined

  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '--start' && args[i + 1]) {
      startUrl = args[++i]
    } else if (a === '--label' && args[i + 1]) {
      label = args[++i]
    }
  }

  if (!startUrl) {
    console.error(
      `No default login URL for "${platform}". Pass --start <url> or add a default in scripts/connect-account.ts`,
    )
    process.exit(1)
  }
  return { platform, startUrl, label }
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, () => {
      rl.close()
      resolve()
    })
  })
}

async function main() {
  const { platform, startUrl, label } = parseArgs()
  const userId = await ensureDevUser()

  console.log(`[connect] platform=${platform} userId=${userId}`)
  console.log(`[connect] launching headful Chromium → ${startUrl}`)

  const managed = await localPlaywrightRuntime.startSession({
    userId,
    platform,
    startUrl,
    headful: true,
  })

  console.log('\n[connect] Browser is open. Please complete the login flow.')
  console.log(
    '[connect] Tips: do NOT press Enter until you see your logged-in dashboard.',
  )
  console.log('[connect] On 2FA prompts wait for the post-login redirect to settle.')
  await waitForEnter('\n[connect] Press Enter once you are fully logged in: ')

  // Verify before saving — skip the probe if no per-platform probe is defined.
  if (PROBES[platform]) {
    console.log(`[connect] Verifying login by visiting ${PROBES[platform]!.loggedInUrl} ...`)
    const verdict = await probeSession(managed.page, platform)
    if (!verdict) {
      console.log('[connect] No probe configured — skipping verification.')
    } else {
      console.log(`[connect] verdict=${verdict.verdict}  finalUrl=${verdict.finalUrl}`)
      console.log(`[connect] hint: ${verdict.hint}`)
      if (verdict.verdict === 'logged_out') {
        console.error('\n[connect] Refusing to save — the session is not logged in.')
        console.error('[connect] Re-run this command and complete the login fully before pressing Enter.')
        await managed.close()
        process.exit(2)
      }
      if (verdict.verdict === 'ambiguous') {
        console.warn('[connect] Probe was ambiguous; saving anyway.')
      }
    }
  }

  console.log('[connect] Capturing storage state...')
  const storageState = await managed.saveStorageState()

  const cookieDomains = new Map<string, number>()
  for (const c of storageState.cookies) {
    cookieDomains.set(c.domain, (cookieDomains.get(c.domain) ?? 0) + 1)
  }
  console.log(`[connect] cookies (${storageState.cookies.length} total):`)
  for (const [domain, n] of [...cookieDomains.entries()].sort()) {
    console.log(`  ${domain.padEnd(30)}  ${n}`)
  }

  const id = await upsertBrowserSession({
    userId,
    platform,
    storageState,
    accountLabel: label ?? null,
    runtime: 'local',
  })

  console.log(`\n[connect] OK — session ${id} saved.`)
  console.log(`[connect] Verify any time with: pnpm browser:check ${platform}`)

  await managed.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('[connect] failed:', err)
  process.exit(1)
})
