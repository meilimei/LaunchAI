/**
 * Mosaiq Cloud runtime — production target.
 *
 * Talks to a self-hosted Mosaiq Cloud control plane (browser-pod pool + REST
 * + Bearer auth + WebSocket CDP proxy). The control plane spawns Chromium in
 * a remote pod with persona-derived launch flags, returns a CDP ws URL, and
 * we connect over it with the same `chromium.connectOverCDP` we'd use for
 * Browserbase or any other CDP-style provider.
 *
 * Activation:
 *   - link `@runova/cloud-sdk` and `@runova/persona-schema` (pnpm link until
 *     they publish to npm)
 *   - set MOSAIQ_API_URL / MOSAIQ_API_KEY / MOSAIQ_PROJECT_ID in .env.local
 *   - set MOSAIQ_DEFAULT_PERSONA_ID to a persona that has already been
 *     registered via `POST /v1/personas` on the control plane
 *   - set BROWSER_RUNTIME=mosaiq
 *
 * See:
 *   - https://github.com/meilimei/Mosaiq/blob/main/docs/LAUNCHAI-INTEGRATION.md
 *   - https://github.com/meilimei/Mosaiq/blob/main/docs/CLOUD-V0-IMPLEMENTATION.md
 *
 * Implementation notes:
 *   - Imports come from `playwright` (LaunchAI uses the full `playwright`
 *     package, which bundles `playwright-core`). The cloud-sdk's
 *     `BrowserContext` parameter is only used at type-time (erased) and at
 *     runtime we pass our `playwright` BrowserContext through — Playwright's
 *     core type lines up structurally.
 *   - v0.11+ pod applies server-side `injectAll` by default (Option A), so
 *     bare `connectOverCDP` already deep-spoofs before any client call.
 *   - `session.injectInto(ctx)` remains idempotent belt-and-suspenders; call
 *     it before the first real `page.goto` when not using `about:blank` only.
 *   - We restore LaunchAI's BrowserStorageState into cookies only. The
 *     browser-pod also keeps a user-data-dir on its volume which holds
 *     IndexedDB / Service Workers; that's pod-side persistence and is
 *     orthogonal to LaunchAI's storageState model.
 */
import { chromium, type BrowserContext, type Page } from 'playwright'
import { nanoid } from 'nanoid'

import { MosaiqCloudClient, type ManagedCloudSession } from '@runova/cloud-sdk'

import type { BrowserRuntime, ManagedBrowser, StartSessionInput } from './types'

const KEEPALIVE_TTL_SECONDS = 86_400 // 24h — matches Mosaiq SESSION_TTL_MAX_KEEPALIVE_SECONDS default

const REQUIRED_ENV = ['MOSAIQ_API_URL', 'MOSAIQ_API_KEY', 'MOSAIQ_PROJECT_ID'] as const
function readEnv() {
  for (const k of REQUIRED_ENV) {
    if (!process.env[k]) throw new Error(`Mosaiq runtime: missing env ${k}`)
  }
  return {
    apiUrl: process.env.MOSAIQ_API_URL!,
    apiKey: process.env.MOSAIQ_API_KEY!,
    projectId: process.env.MOSAIQ_PROJECT_ID!,
  }
}

let cachedClient: MosaiqCloudClient | null = null
function getClient(): MosaiqCloudClient {
  if (cachedClient) return cachedClient
  const env = readEnv()
  const requestTimeoutMs = Number(process.env.MOSAIQ_REQUEST_TIMEOUT_MS ?? '180000')
  cachedClient = new MosaiqCloudClient({ ...env, requestTimeoutMs })
  return cachedClient
}

/**
 * Resolve which Mosaiq persona to use for a given LaunchAI user.
 *
 * v0.11 phase 11.1: LaunchAI doesn't have a per-user persona DB yet, so we
 * fall back to MOSAIQ_DEFAULT_PERSONA_ID (a persona registered on the control
 * plane via `POST /v1/personas`). When LaunchAI gains a per-user persona
 * model, wire it here.
 */
async function resolvePersonaIdForUser(_userId: string): Promise<string> {
  const id = process.env.MOSAIQ_DEFAULT_PERSONA_ID
  if (!id) {
    throw new Error(
      'Mosaiq runtime: MOSAIQ_DEFAULT_PERSONA_ID is not set. Either set it to a ' +
        'persona id you previously POSTed to /v1/personas, or extend ' +
        'resolvePersonaIdForUser() to look up the user-specific persona.',
    )
  }
  return id
}

export const mosaiqCloudRuntime: BrowserRuntime = {
  kind: 'mosaiq',
  async startSession(input: StartSessionInput): Promise<ManagedBrowser> {
    const client = getClient()
    const personaId = await resolvePersonaIdForUser(input.userId)
    const stickyKey = `launchai:${input.userId}:${input.platform}`

    const sess: ManagedCloudSession = await client.createSessionOrRejoin({
      persona: { id: personaId },
      // headful makes no sense for a cloud pod — it always renders headless.
      stealth: { inject: true, humanize: true, rebrowserPatches: true },
      keepAlive: true,
      userMetadata: { stickyKey },
      ttlSeconds: KEEPALIVE_TTL_SECONDS,
      clientLabel: `launchai:${input.userId}:${input.platform}`,
    })

    let browser
    try {
      browser = await chromium.connectOverCDP(sess.cdpUrl, {
        headers: { Authorization: `Bearer ${client.apiKey}` },
        timeout: 30_000,
      })
    } catch (err) {
      // If the CDP handshake never lands, the session is wedged on the cloud
      // side too. Release it before bubbling up.
      await sess.close().catch(() => undefined)
      throw err
    }

    // The pod's `--user-data-dir` always spawns at least one default context;
    // we reuse it so storageState and persona injection live on the same one.
    const ctx: BrowserContext = browser.contexts()[0] ?? (await browser.newContext())

    // Belt-and-suspenders: server-side injectAll (Option A) already deep-spoofs
    // before first navigation; injectInto remains idempotent if called again.
    await sess.injectInto(ctx as unknown as Parameters<typeof sess.injectInto>[0])

    if (input.storageState) {
      await ctx.addCookies(input.storageState.cookies ?? [])
      // IndexedDB / Service Worker state lives in the pod's user-data-dir and
      // survives across grooming cycles via keepAlive + stickyKey (phase 11.5).
    }

    const page: Page = ctx.pages()[0] ?? (await ctx.newPage())
    if (input.startUrl) {
      await page.goto(input.startUrl, { waitUntil: 'domcontentloaded' })
    }

    const id = `mosaiq_${nanoid(10)}`

    return {
      id,
      runtime: 'mosaiq',
      page,
      async saveStorageState() {
        const state = await ctx.storageState()
        return state as Awaited<ReturnType<ManagedBrowser['saveStorageState']>>
      },
      async close() {
        try {
          await browser.close()
        } catch {
          /* browser already disconnected; pod stays alive for keepAlive sessions */
        }
        // Disconnect CDP only — pod + user-data-dir persist for next grooming cycle.
        sess.disconnect()
      },
    }
  },
}
