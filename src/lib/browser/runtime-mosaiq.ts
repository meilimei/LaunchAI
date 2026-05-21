/**
 * Mosaiq runtime — anti-detection-hardened Chromium via @mosaiq/sdk.
 *
 * Mosaiq (https://github.com/meilimei/Mosaiq) is a persona-driven anti-detection
 * wrapper around Playwright. It injects a CDP init script before any page JS
 * runs to spoof:
 *
 *   - navigator.userAgent / userAgentData (UA-CH) in both main and worker scope
 *   - navigator.platform / vendor / hardwareConcurrency / deviceMemory
 *   - screen.* / window.devicePixelRatio
 *   - Intl / Date timezone
 *   - Canvas / WebGL / Audio fingerprint noise (with double-guard for CreepJS)
 *   - WebGL 49-parameter ANGLE D3D11 spoof (UNMASKED_VENDOR / RENDERER / ...)
 *   - WebRTC STUN candidate IP leak
 *   - permissions.query / mediaDevices.enumerateDevices
 *
 * It also exposes a humanize layer (bezier mouse trajectories, lognormal
 * keyboard flight times). The humanize layer is wired up in Layer 2 of the
 * integration; this runtime is Layer 1 (drop-in BrowserRuntime swap).
 *
 * Activation:
 *
 *   1. Install Mosaiq SDK alongside LaunchAI. Mosaiq is not on npm yet; the
 *      easiest path is to clone the Mosaiq repo as a sibling and add a
 *      file-protocol dependency:
 *
 *        git clone https://github.com/meilimei/Mosaiq.git ../Mosaiq
 *        cd ../Mosaiq && pnpm install && pnpm -r build
 *        cd ../LaunchAI
 *        pnpm add file:../Mosaiq/packages/persona-schema \
 *                 file:../Mosaiq/packages/sdk
 *
 *   2. Install Mosaiq's bundled Chromium (separate from LaunchAI's
 *      playwright@1.49 because Mosaiq pins playwright-core@1.59):
 *
 *        pnpm --filter @mosaiq/sdk exec playwright install chromium
 *
 *   3. Enable in env:
 *
 *        BROWSER_RUNTIME=mosaiq
 *        MOSAIQ_RUNTIME_ROOT=./.mosaiq-profiles  # keep profile dirs in-repo
 *        MOSAIQ_DEFAULT_TEMPLATE=win11-chrome-us
 *        MOSAIQ_DEFAULT_TIMEZONE=America/New_York
 *
 * Semantics:
 *
 *   - One Mosaiq persona per (userId, platform), id = `launchai-<hash>-<platform>`
 *   - First launch creates the persona from the configured template;
 *     subsequent launches reuse it.
 *   - storageState() returns Playwright's view of cookies + localStorage,
 *     but the source of truth is Mosaiq's persistent user-data-dir on disk
 *     (same model LaunchAI's local runtime already uses).
 *
 * If `@mosaiq/sdk` is not installed and BROWSER_RUNTIME=mosaiq is set, this
 * runtime fails fast at startSession() with a clear error pointing at the
 * install instructions — same pattern as the browserbase stub.
 *
 * See docs/MOSAIQ_RUNTIME.md for the full integration plan (Layer 1/2/3).
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { nanoid } from 'nanoid'
import type {
  BrowserRuntime,
  BrowserStorageState,
  ManagedBrowser,
  StartSessionInput,
} from './types'

const SUPPORTED_TEMPLATES = [
  'win11-chrome-us',
  'win10-chrome-us',
  'macos-sonoma-chrome-us',
  'ubuntu-2204-chrome-us',
] as const
type TemplateId = (typeof SUPPORTED_TEMPLATES)[number]

function resolveTemplate(): TemplateId {
  const raw = (process.env.MOSAIQ_DEFAULT_TEMPLATE ?? 'win11-chrome-us') as TemplateId
  return (SUPPORTED_TEMPLATES as readonly string[]).includes(raw) ? raw : 'win11-chrome-us'
}

function setProfileRoot() {
  // Mosaiq SDK reads MOSAIQ_RUNTIME_ROOT from process.env at launch time.
  // Default it into the LaunchAI tree so the local and mosaiq runtimes
  // have parallel on-disk layouts and ops can rsync them.
  if (!process.env.MOSAIQ_RUNTIME_ROOT) {
    process.env.MOSAIQ_RUNTIME_ROOT = path.resolve(process.cwd(), '.mosaiq-profiles')
  }
}

/**
 * Derive a Mosaiq-compliant persona id from (userId, platform).
 *
 * Mosaiq's PersonaIdSchema enforces `/^[a-z][a-z0-9-]{2,63}$/`. Clerk userIds
 * are typically `user_<base64ish>` (~30 chars) which would push us past the
 * 64-char limit after the `launchai-` prefix. We hash the userId to a short
 * stable id instead.
 */
export function personaIdFor(userId: string, platform: string): string {
  const userHash = crypto
    .createHash('sha1')
    .update(userId)
    .digest('hex')
    .slice(0, 12)
  const platformSlug = platform
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
  return `launchai-${userHash}-${platformSlug}`
}

/**
 * Loaded lazily via dynamic import so a missing @mosaiq/sdk dep doesn't
 * break LaunchAI's typecheck / build for users who never enable the mosaiq
 * runtime. The runtime fails fast with a helpful error if the import fails.
 */
interface MosaiqSdk {
  launchPersona: (persona: unknown, opts?: { headless?: boolean }) => Promise<MosaiqBrowserSession>
  loadPersona: (id: string) => unknown
  savePersona: (persona: unknown) => unknown
  personaExists: (id: string) => boolean
}

interface MosaiqBrowserSession {
  context: {
    pages(): Array<unknown>
    newPage(): Promise<unknown>
    storageState(): Promise<BrowserStorageState>
  }
  close(): Promise<void>
}

interface MosaiqTemplates {
  createWin11ChromeUsPersona: (input: PersonaInput) => unknown
  createWin10ChromeUsPersona: (input: PersonaInput) => unknown
  createMacosSonomaChromeUsPersona: (input: PersonaInput) => unknown
  createUbuntu2204ChromeUsPersona: (input: PersonaInput) => unknown
}

interface PersonaInput {
  id: string
  displayName: string
  timezone?: string
  tags?: string[]
}

async function loadMosaiq(): Promise<{ sdk: MosaiqSdk; templates: MosaiqTemplates }> {
  // Indirect import to keep TypeScript from requiring the optional @mosaiq/sdk
  // package at compile time. The runtime still imports normally; only the
  // typechecker is opted out via the variable-string form.
  const importer = (id: string) => import(/* @vite-ignore */ /* webpackIgnore: true */ id)
  try {
    const [sdk, templates] = await Promise.all([
      importer('@mosaiq/sdk') as Promise<MosaiqSdk>,
      importer('@mosaiq/persona-schema/templates') as Promise<MosaiqTemplates>,
    ])
    return { sdk, templates }
  } catch (err) {
    throw new Error(
      'Mosaiq runtime is enabled (BROWSER_RUNTIME=mosaiq) but @mosaiq/sdk ' +
        'is not installed.\n' +
        'See docs/MOSAIQ_RUNTIME.md for setup. Quick path:\n' +
        '  git clone https://github.com/meilimei/Mosaiq.git ../Mosaiq\n' +
        '  cd ../Mosaiq && pnpm install && pnpm -r build\n' +
        '  cd - && pnpm add file:../Mosaiq/packages/persona-schema ' +
        'file:../Mosaiq/packages/sdk\n' +
        '  pnpm --filter @mosaiq/sdk exec playwright install chromium\n' +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function buildPersona(
  templates: MosaiqTemplates,
  personaId: string,
  displayName: string,
): unknown {
  const tz = process.env.MOSAIQ_DEFAULT_TIMEZONE ?? 'America/New_York'
  const input: PersonaInput = { id: personaId, displayName, timezone: tz, tags: ['launchai'] }
  switch (resolveTemplate()) {
    case 'win10-chrome-us':
      return templates.createWin10ChromeUsPersona(input)
    case 'macos-sonoma-chrome-us':
      return templates.createMacosSonomaChromeUsPersona(input)
    case 'ubuntu-2204-chrome-us':
      return templates.createUbuntu2204ChromeUsPersona(input)
    default:
      return templates.createWin11ChromeUsPersona(input)
  }
}

// Track live sessions so concurrent launches against the same persona are
// rejected (matches LaunchAI's local-runtime contract).
const liveSessions = new Map<string, MosaiqBrowserSession>()

export const mosaiqRuntime: BrowserRuntime = {
  kind: 'mosaiq',
  async startSession(input: StartSessionInput): Promise<ManagedBrowser> {
    setProfileRoot()
    const personaId = personaIdFor(input.userId, input.platform)
    const displayName = `${input.platform}:${input.userId.slice(0, 16)}`

    if (liveSessions.has(personaId)) {
      throw new Error(
        `Mosaiq persona already in use: ${personaId}\n` +
          'Close the existing session first (single-writer per persona).',
      )
    }

    const { sdk, templates } = await loadMosaiq()

    const persona = sdk.personaExists(personaId)
      ? sdk.loadPersona(personaId)
      : sdk.savePersona(buildPersona(templates, personaId, displayName))

    const headful =
      input.headful ?? (process.env.BROWSER_HEADFUL === '1' ? true : false)

    const session = await sdk.launchPersona(persona, { headless: !headful })
    liveSessions.set(personaId, session)

    const ctx = session.context
    // Cast to unknown then to LaunchAI's Page — Mosaiq returns a Page from
    // playwright-core@1.59 which is structurally compatible with LaunchAI's
    // playwright@1.49 Page. The cast lives at this boundary so the rest of
    // the codebase stays version-agnostic.
    const pages = ctx.pages()
    const firstPage = (pages[0] ?? (await ctx.newPage())) as unknown as ManagedBrowser['page']

    if (input.startUrl) {
      // We can't call firstPage.goto here without a real Playwright Page type
      // — but ctx is structurally compatible: cast and navigate.
      await (firstPage as unknown as { goto: (u: string, o?: object) => Promise<unknown> }).goto(
        input.startUrl,
        { waitUntil: 'domcontentloaded' },
      )
    }

    const id = `mosaiq_${nanoid(10)}`

    return {
      id,
      runtime: 'mosaiq',
      page: firstPage,
      async saveStorageState(): Promise<BrowserStorageState> {
        // Mosaiq's user-data-dir is the real source of truth (IndexedDB +
        // service workers are persisted there). This snapshot is only used
        // for `pnpm browser:check` style diagnostics.
        return (await ctx.storageState()) as BrowserStorageState
      },
      async close() {
        liveSessions.delete(personaId)
        await session.close().catch(() => undefined)
      },
    }
  },
}

export async function shutdownMosaiqRuntime() {
  for (const s of liveSessions.values()) {
    await s.close().catch(() => undefined)
  }
  liveSessions.clear()
}
