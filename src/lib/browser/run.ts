/**
 * High-level "run a browser task" helper.
 *
 * Combines runtime + session-store + agent loop into a single entry point
 * platform adapters call. Handles:
 *
 *   - loading the persisted browser session for (userId, platform)
 *   - starting a ManagedBrowser with that session
 *   - executing the bounded agent loop against the goal
 *   - re-saving storageState after the run (cookies may have rotated)
 *   - closing the browser even on failure
 *
 * Adapters never deal with Playwright directly — they just describe the
 * goal + context. If no session exists, the helper raises NeedsReauth so
 * the campaign supervisor can pause the platform and request user reconnect.
 */
import { getBrowserRuntime } from './runtime'
import { runBrowserAgent, type BrowserAgentResult } from './agent'
import { lookupSelectorHints, recordTrajectoryHints } from './selector-hints'
import {
  loadBrowserSession,
  markBrowserSessionStatus,
  markBrowserSessionUsed,
} from './session-store'

export class NeedsReauthError extends Error {
  constructor(public platform: string) {
    super(`No connected browser session for platform "${platform}". User must reconnect.`)
    this.name = 'NeedsReauthError'
  }
}

export interface RunBrowserTaskInput {
  userId: string
  platform: string
  goal: string
  startUrl: string
  context?: Record<string, unknown>
  systemAddendum?: string
  maxSteps?: number
  maxWallclockMs?: number
}

export interface RunBrowserTaskResult extends BrowserAgentResult {
  sessionId: string
  platform: string
}

export async function runBrowserTask(
  input: RunBrowserTaskInput,
): Promise<RunBrowserTaskResult> {
  const session = await loadBrowserSession(input.userId, input.platform)
  if (!session) {
    throw new NeedsReauthError(input.platform)
  }

  const runtime = getBrowserRuntime()
  const managed = await runtime.startSession({
    userId: input.userId,
    platform: input.platform,
    startUrl: input.startUrl,
  })

  await markBrowserSessionUsed(session.id)

  let agentResult: BrowserAgentResult
  try {
    agentResult = await runBrowserAgent({
      page: managed.page,
      goal: input.goal,
      context: input.context,
      systemAddendum: input.systemAddendum,
      maxSteps: input.maxSteps,
      maxWallclockMs: input.maxWallclockMs,
      // Wire cross-user selector telemetry. The agent calls this every
      // time it lands on a new URL pattern to fetch selectors that have
      // worked on similar pages in past runs.
      hintLookup: (urlPattern) => lookupSelectorHints(input.platform, urlPattern),
    })

    // Detect reauth on common login indicators — the persistent profile
    // could have expired server-side (token rotation, password change).
    const url = managed.page.url()
    if (/\/login|\/signin|accounts\.google|\/oauth/i.test(url)) {
      await markBrowserSessionStatus(session.id, 'expired')
    }
  } finally {
    await managed.close().catch(() => undefined)
  }

  // Persist what worked / didn't work on each URL pattern for future runs.
  // Fire-and-forget: telemetry should never break a successful agent run,
  // so we swallow errors (recordTrajectoryHints has its own internal
  // per-row try/catch too).
  recordTrajectoryHints(input.platform, agentResult.trajectory).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[run] recordTrajectoryHints failed: ${message}`)
  })

  return {
    ...agentResult,
    sessionId: session.id,
    platform: input.platform,
  }
}
