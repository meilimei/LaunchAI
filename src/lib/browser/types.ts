/**
 * Browser runtime contract.
 *
 * The agent layer talks to BrowserRuntime; concrete implementations wrap
 * either local Playwright (dev) or Browserbase (prod) so the rest of the
 * codebase never imports Playwright directly.
 *
 * See docs/BROWSER_AUTONOMY.md.
 */
import type { Page } from 'playwright'

export type BrowserRuntimeKind = 'local' | 'browserbase' | 'mosaiq'

/**
 * Playwright `storageState` shape — cookies + per-origin localStorage.
 * Re-exported here so callers don't need to import from playwright.
 */
export interface BrowserStorageState {
  cookies: Array<{
    name: string
    value: string
    domain: string
    path: string
    expires: number
    httpOnly: boolean
    secure: boolean
    sameSite: 'Strict' | 'Lax' | 'None'
  }>
  origins: Array<{
    origin: string
    localStorage: Array<{ name: string; value: string }>
  }>
}

export interface StartSessionInput {
  /** Owner of the session — must match the campaign's user. */
  userId: string
  /** Platform identifier (`reddit`, `x`, `product_hunt`, ...). */
  platform: string
  /** Optional persisted storageState to resume a logged-in session. */
  storageState?: BrowserStorageState
  /** When true, browser is shown to the human (used during onboarding). */
  headful?: boolean
  /** Initial URL to navigate to right after the page is created. */
  startUrl?: string
}

export interface ManagedBrowser {
  readonly id: string
  readonly runtime: BrowserRuntimeKind
  readonly page: Page
  /** Capture cookies + localStorage for persistence. */
  saveStorageState(): Promise<BrowserStorageState>
  close(): Promise<void>
}

export interface BrowserRuntime {
  readonly kind: BrowserRuntimeKind
  startSession(input: StartSessionInput): Promise<ManagedBrowser>
}
