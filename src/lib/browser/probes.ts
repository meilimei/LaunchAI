/**
 * Per-platform login probes.
 *
 * Used by both `connect:account` (to refuse saving a half-baked session)
 * and `browser:check` (to diagnose an existing session).
 *
 * Probes are derived from `PlatformManifest.loginProbe` so there's one
 * source of truth per platform. Tweaking the markers means editing the
 * manifest, not this file.
 */
import type { Page } from 'playwright'
import { PLATFORM_MANIFESTS } from '@/lib/platforms/manifests'
import type { PlatformId } from '@/lib/platforms/types'

export interface PlatformProbe {
  /** URL the script visits to check whether the session works. */
  loggedInUrl: string
  /** If the final URL contains any of these, conclude logged-out. */
  loggedOutMarkers: string[]
  /** If any of these substrings appear in the page text, conclude logged-in. */
  loggedInTextMarkers: string[]
  /**
   * If any of these appear in the page text AND no loggedInTextMarkers match,
   * conclude logged-out. Catches "we didn't redirect but the page is clearly
   * a public marketing variant".
   */
  loggedOutTextMarkers?: string[]
}

/**
 * Build the probes map from the manifest registry. Platforms whose manifest
 * declares no real markers (e.g. blog — API-only auth) are filtered out so
 * `connect:account` correctly reports "no probe configured".
 */
function buildProbes(): Record<string, PlatformProbe> {
  const out: Record<string, PlatformProbe> = {}
  for (const id of Object.keys(PLATFORM_MANIFESTS) as PlatformId[]) {
    const lp = PLATFORM_MANIFESTS[id].loginProbe
    if (lp.loggedInTextMarkers.length === 0 && lp.loggedOutUrlMarkers.length === 0) {
      continue // not a real browser-auth platform
    }
    out[id] = {
      loggedInUrl: lp.loggedInUrl,
      loggedOutMarkers: lp.loggedOutUrlMarkers,
      loggedInTextMarkers: lp.loggedInTextMarkers,
      loggedOutTextMarkers: lp.loggedOutTextMarkers,
    }
  }
  return out
}

export const PROBES: Record<string, PlatformProbe> = buildProbes()

export type ProbeVerdict = 'logged_in' | 'logged_out' | 'ambiguous'

export interface ProbeResult {
  verdict: ProbeVerdict
  finalUrl: string
  title: string
  hint: string
}

export async function probeSession(
  page: Page,
  platform: string,
): Promise<ProbeResult | null> {
  const probe = PROBES[platform]
  if (!probe) return null

  await page.goto(probe.loggedInUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  // Allow client-side redirects to settle.
  await new Promise((r) => setTimeout(r, 2000))

  const finalUrl = page.url()
  const title = await page.title().catch(() => '')
  const bodyText = await page
    .innerText('body', { timeout: 5000 })
    .catch(() => '')

  const seemsLoggedOut = probe.loggedOutMarkers.some((m) => finalUrl.includes(m))
  const seemsLoggedIn = probe.loggedInTextMarkers.some((m) =>
    bodyText.toLowerCase().includes(m.toLowerCase()),
  )

  if (seemsLoggedOut) {
    return {
      verdict: 'logged_out',
      finalUrl,
      title,
      hint: `URL redirected to a login page (${probe.loggedOutMarkers.find((m) => finalUrl.includes(m))}).`,
    }
  }
  if (seemsLoggedIn) {
    return {
      verdict: 'logged_in',
      finalUrl,
      title,
      hint: `Found logged-in marker on ${probe.loggedInUrl}.`,
    }
  }
  // Tertiary check — page didn't redirect but shows public CTA.
  const loggedOutByText = probe.loggedOutTextMarkers?.find((m) =>
    bodyText.toLowerCase().includes(m.toLowerCase()),
  )
  if (loggedOutByText) {
    return {
      verdict: 'logged_out',
      finalUrl,
      title,
      hint: `Page text contains "${loggedOutByText}" — looks like a public/marketing view.`,
    }
  }
  return {
    verdict: 'ambiguous',
    finalUrl,
    title,
    hint: 'Neither login redirect nor logged-in markers detected.',
  }
}
