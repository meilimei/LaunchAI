/**
 * Clear the platform-wide cooldown on an account_state so dev testing
 * can resume without waiting out the real timer.
 *
 * Usage:
 *   pnpm dev:clear-cooldown <platform>           # clear platform cooldown
 *   pnpm dev:clear-cooldown <platform> --sub=x   # clear just r/x cooldown
 *
 * Only for development. In production, cooldowns exist for a reason — we
 * don't ship a "clear my penalty box" button to end users.
 */
import { ensureDevUser } from '@/lib/dev-user'
import {
  loadAccountState,
  updateAccountState,
  normalizeSubreddit,
} from '@/lib/browser/account-state'
import type { PlatformId } from '@/lib/platforms/types'

const VALID_PLATFORMS: PlatformId[] = [
  'x',
  'reddit',
  'product_hunt',
  'hacker_news',
  'indie_hackers',
  'cws',
  'blog',
]

async function main() {
  const args = process.argv.slice(2)
  if (args.length < 1) {
    console.error(
      'Usage: pnpm dev:clear-cooldown <platform> [--sub=<name>]\n' +
        `  platforms: ${VALID_PLATFORMS.join(', ')}`,
    )
    process.exit(1)
  }
  const platform = args[0] as PlatformId
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(`Unknown platform: ${platform}`)
  }
  const subArg = args.find((a) => a.startsWith('--sub='))
  const sub = subArg ? normalizeSubreddit(subArg.slice('--sub='.length)) : null

  const userId = await ensureDevUser()
  const before = await loadAccountState(userId, platform)
  if (!before) {
    console.log(`[clear-cooldown] no account_state row for ${platform}; nothing to clear.`)
    return
  }

  if (sub) {
    // Clear just the per-subreddit cooldown.
    const subState = before.subredditState?.[sub]
    if (!subState?.cooldownUntil) {
      console.log(`[clear-cooldown] r/${sub} has no active cooldown.`)
      return
    }
    console.log(
      `[clear-cooldown] clearing r/${sub}: ` +
        `reason=${subState.cooldownReason} until=${subState.cooldownUntil}`,
    )
    await updateAccountState(userId, platform, (cur) => {
      const next = { ...cur }
      const subs = { ...(next.subredditState ?? {}) }
      const s = { ...(subs[sub] ?? {}) }
      delete s.cooldownUntil
      delete s.cooldownReason
      delete s.cooldownEvidence
      subs[sub] = s
      next.subredditState = subs
      return next
    })
    console.log(`[clear-cooldown] done. r/${sub} cooldown cleared.`)
    return
  }

  // Platform-wide.
  if (!before.cooldownUntil) {
    console.log(`[clear-cooldown] ${platform} has no active platform cooldown.`)
    return
  }
  console.log(
    `[clear-cooldown] clearing ${platform}: ` +
      `reason=${before.cooldownReason} until=${before.cooldownUntil}\n` +
      `evidence: ${before.cooldownEvidence ?? '<none>'}`,
  )
  await updateAccountState(userId, platform, (cur) => {
    const next = { ...cur }
    delete next.cooldownUntil
    delete next.cooldownReason
    delete next.cooldownEvidence
    return next
  })
  console.log(`[clear-cooldown] done.`)
}

main().catch((err) => {
  console.error('[clear-cooldown] error:', err)
  process.exit(1)
})
