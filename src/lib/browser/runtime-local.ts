/**
 * Local Playwright runtime — persistent-context model.
 *
 * Each (userId, platform) gets its own on-disk Chromium user-data-dir at
 *   <BROWSER_PROFILES_DIR>/<userId>/<platform>/
 *
 * `launchPersistentContext` is used instead of `launch + newContext` because
 * Playwright's `storageState()` does NOT export IndexedDB or Service Workers.
 * Many platforms (Indie Hackers / Firebase Auth, X / hCaptcha cookies, etc.)
 * keep the actual session token in IndexedDB, so storageState round-trips lose
 * the login.
 *
 * Persistent profiles fix that: the entire browser profile (cookies +
 * localStorage + IndexedDB + service workers + cache) is on disk, so the
 * second time we open the same dir, the user is still logged in.
 *
 * Tradeoffs:
 *   - One Chromium process per session (cannot pool across platforms).
 *   - Single-writer per profile: do not run two scripts against the same
 *     (userId, platform) simultaneously — the second launch will fail with
 *     'user data dir is in use'.
 *   - Profile dirs grow over time. The connect:account script writes them
 *     and they should be considered secrets (cookies + tokens at rest).
 *
 * Browserbase prod uses its own session-persistence mechanism; see
 * docs/BROWSER_AUTONOMY.md §4.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium, type BrowserContext } from 'playwright'
import { nanoid } from 'nanoid'
import type {
  BrowserRuntime,
  BrowserStorageState,
  ManagedBrowser,
  StartSessionInput,
} from './types'

function sanitize(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function profileDirFor(userId: string, platform: string): string {
  const root =
    process.env.BROWSER_PROFILES_DIR ?? path.resolve(process.cwd(), '.browser-profiles')
  return path.join(root, sanitize(userId), sanitize(platform))
}

// Track open contexts so we can refuse a second concurrent launch against
// the same profile dir (Chromium would otherwise crash with a confusing error).
const openContexts = new Map<string, BrowserContext>()

export const localPlaywrightRuntime: BrowserRuntime = {
  kind: 'local',
  async startSession(input: StartSessionInput): Promise<ManagedBrowser> {
    const headful =
      input.headful ?? (process.env.BROWSER_HEADFUL === '1' ? true : false)

    const profileDir = profileDirFor(input.userId, input.platform)
    await fs.mkdir(profileDir, { recursive: true })

    if (openContexts.has(profileDir)) {
      throw new Error(
        `Browser profile already in use: ${profileDir}\nClose the existing browser session first.`,
      )
    }

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: !headful,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      // Make automation slightly less obvious to platform anti-bot.
      args: ['--disable-blink-features=AutomationControlled'],
    })
    openContexts.set(profileDir, context)

    const page = context.pages()[0] ?? (await context.newPage())

    if (input.startUrl) {
      await page.goto(input.startUrl, { waitUntil: 'domcontentloaded' })
    }

    const id = `local_${nanoid(10)}`

    return {
      id,
      runtime: 'local',
      page,
      async saveStorageState(): Promise<BrowserStorageState> {
        // Snapshot only — the persistent profile dir is the source of truth.
        const state = await context.storageState()
        return state as BrowserStorageState
      },
      async close() {
        openContexts.delete(profileDir)
        await context.close().catch(() => undefined)
      },
    }
  },
}

export async function shutdownLocalBrowserRuntime() {
  for (const ctx of openContexts.values()) {
    await ctx.close().catch(() => undefined)
  }
  openContexts.clear()
}
