/**
 * Browser runtime selector.
 *
 * Reads BROWSER_RUNTIME (default `local`) and returns the matching backend.
 * The rest of the app calls `getBrowserRuntime()` and never knows whether
 * Playwright is running locally or talking to Browserbase.
 */
import type { BrowserRuntime, BrowserRuntimeKind } from './types'
import { localPlaywrightRuntime } from './runtime-local'
import { browserbaseRuntime } from './runtime-browserbase'

function resolveKind(): BrowserRuntimeKind {
  const raw = (process.env.BROWSER_RUNTIME ?? 'local').toLowerCase()
  if (raw === 'browserbase') return 'browserbase'
  return 'local'
}

export function getBrowserRuntime(): BrowserRuntime {
  const kind = resolveKind()
  if (kind === 'browserbase') return browserbaseRuntime
  return localPlaywrightRuntime
}

export type { BrowserRuntime, ManagedBrowser, BrowserStorageState, StartSessionInput } from './types'
