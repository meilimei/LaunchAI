/**
 * Browserbase runtime — production target.
 *
 * Browserbase exposes a Chrome session over CDP. Playwright can connect to
 * it via `chromium.connectOverCDP(connectUrl)`, after which everything works
 * the same as the local runtime.
 *
 * Activation:
 *   - install `@browserbasehq/sdk` (deferred until milestone B1)
 *   - set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID
 *   - set BROWSER_RUNTIME=browserbase
 *
 * Until the SDK is added this module throws a clear error so callers know
 * exactly what is missing instead of silently falling through.
 */
import type { BrowserRuntime, ManagedBrowser, StartSessionInput } from './types'

export const browserbaseRuntime: BrowserRuntime = {
  kind: 'browserbase',
  async startSession(_input: StartSessionInput): Promise<ManagedBrowser> {
    throw new Error(
      'Browserbase runtime not yet implemented. Add @browserbasehq/sdk and set ' +
        'BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID, then implement startSession ' +
        'using chromium.connectOverCDP(session.connectUrl). See docs/BROWSER_AUTONOMY.md §4.',
    )
  },
}
