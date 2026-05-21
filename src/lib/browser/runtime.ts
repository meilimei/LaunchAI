/**
 * Browser runtime selector.
 *
 * Reads BROWSER_RUNTIME (default `local`) and returns the matching backend.
 * The rest of the app calls `getBrowserRuntime()` and never knows whether
 * Playwright is running locally, talking to Browserbase, or going through
 * Mosaiq's anti-detection layer.
 *
 * Supported backends:
 *   - `local`      — bare Playwright (dev default)
 *   - `browserbase`— Browserbase cloud (prod target, stub for now)
 *   - `mosaiq`     — Mosaiq anti-detection runtime (see docs/MOSAIQ_RUNTIME.md)
 */
import type { BrowserRuntime, BrowserRuntimeKind } from './types'
import { localPlaywrightRuntime } from './runtime-local'
import { browserbaseRuntime } from './runtime-browserbase'
import { mosaiqRuntime } from './runtime-mosaiq'

function resolveKind(): BrowserRuntimeKind {
  const raw = (process.env.BROWSER_RUNTIME ?? 'local').toLowerCase()
  if (raw === 'browserbase') return 'browserbase'
  if (raw === 'mosaiq') return 'mosaiq'
  return 'local'
}

export function getBrowserRuntime(): BrowserRuntime {
  const kind = resolveKind()
  if (kind === 'browserbase') return browserbaseRuntime
  if (kind === 'mosaiq') return mosaiqRuntime
  return localPlaywrightRuntime
}

export type { BrowserRuntime, ManagedBrowser, BrowserStorageState, StartSessionInput } from './types'
