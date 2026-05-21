import type { ProductType } from '@/lib/agents/types'

/**
 * Detect what kind of product URL we're dealing with so the orchestrator
 * can route to the right scraper.
 *
 * This is a deterministic pattern match, NOT an LLM call —
 * keep cheap, fast, deterministic decisions in code.
 */

export type SourceType = 'cws' | 'github' | 'web'

export interface UrlInfo {
  url: string
  sourceType: SourceType
  productType: ProductType
  /** For CWS, this is the extension id from the URL. */
  externalId?: string
  hostname: string
}

const CWS_HOSTS = new Set([
  'chrome.google.com',
  'chromewebstore.google.com',
])

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

export function detectUrl(input: string): UrlInfo {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error(`Invalid URL: ${input}`)
  }

  const hostname = parsed.hostname.toLowerCase()

  // Chrome Web Store (legacy or new domain)
  if (CWS_HOSTS.has(hostname)) {
    const extId = extractCwsExtensionId(parsed)
    return {
      url: input,
      sourceType: 'cws',
      productType: 'chrome_extension',
      externalId: extId,
      hostname,
    }
  }

  // GitHub
  if (GITHUB_HOSTS.has(hostname)) {
    return {
      url: input,
      sourceType: 'github',
      productType: detectProductTypeFromHostname(hostname, parsed.pathname),
      hostname,
    }
  }

  // Generic web product
  return {
    url: input,
    sourceType: 'web',
    productType: detectProductTypeFromHostname(hostname, parsed.pathname),
    hostname,
  }
}

/**
 * CWS URLs look like:
 *   https://chromewebstore.google.com/detail/<slug>/<id>
 *   https://chrome.google.com/webstore/detail/<slug>/<id>
 * The id is the last 32-char hex-ish path segment.
 */
function extractCwsExtensionId(parsed: URL): string | undefined {
  const segments = parsed.pathname.split('/').filter(Boolean)
  const last = segments[segments.length - 1]
  if (last && /^[a-z0-9]{20,40}$/i.test(last)) {
    return last
  }
  return undefined
}

/**
 * Heuristic for non-CWS URLs. We refine via crawler later.
 */
function detectProductTypeFromHostname(hostname: string, pathname: string): ProductType {
  if (hostname.includes('marketplace.visualstudio.com') && pathname.includes('items')) {
    return 'vscode_extension'
  }
  if (hostname.endsWith('.dev') || hostname.endsWith('.io') || hostname.endsWith('.app')) {
    return 'saas'
  }
  return 'unknown'
}

/**
 * Build the canonical CWS detail URL from an extension id.
 * Used when we have an id but no URL (e.g., for related extensions).
 */
export function cwsDetailUrl(extensionId: string): string {
  return `https://chromewebstore.google.com/detail/${extensionId}`
}
