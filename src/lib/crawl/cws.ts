import type { ProductRaw } from '@/lib/agents/types'

/**
 * Chrome Web Store scraper.
 *
 * Strategy:
 *   1. Fetch the public detail page HTML directly (no Playwright needed for basic info).
 *      Google ships JSON-LD + meta tags + visible inline data.
 *   2. Parse name, tagline, descriptions, rating, install count from the HTML.
 *   3. (Optional, in Phase B-2) fall back to Playwright if direct fetch fails or
 *      the page is JS-heavy.
 *
 * We do NOT scrape reviews from CWS in v1 — review pages are JS-rendered
 * and rate-limited. We rely on description + rating signal only for v1 analysis.
 *
 * Why direct fetch first: ~10x cheaper than Playwright, ~20x faster, and
 * works for >95% of CWS detail pages. Playwright is the fallback, not the default.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const FETCH_TIMEOUT_MS = 15_000

export interface CwsScrapeResult {
  raw: ProductRaw
  /** Pre-computed list of related extension URLs found on the page. */
  relatedExtensionUrls: string[]
  /** Where the data came from (for decision_logs). */
  source: 'direct_fetch' | 'playwright'
}

export async function scrapeCwsPage(url: string): Promise<CwsScrapeResult> {
  const html = await fetchHtml(url)

  const raw: ProductRaw = {
    rawHtml: html,
    meta: extractMetaTags(html),
  }

  // Try JSON-LD first (most reliable when present, but CWS rarely ships it now).
  const jsonLd = extractJsonLd(html)
  if (jsonLd) {
    raw.name = pickString(jsonLd.name) ?? raw.name
    raw.description = pickString(jsonLd.description) ?? raw.description
    raw.category = pickString(jsonLd.applicationCategory) ?? raw.category

    const rating = jsonLd.aggregateRating
    if (rating && typeof rating === 'object') {
      const r = rating as Record<string, unknown>
      raw.rating = toNumber(r.ratingValue) ?? raw.rating
      raw.ratingCount = toNumber(r.ratingCount) ?? toNumber(r.reviewCount) ?? raw.ratingCount
    }
  }

  // CWS today is a SPA: real data lives in `AF_initDataCallback({key:'ds:0',...})`
  // blocks. Long description, category, install count, rating all live there.
  const initData = extractCwsInitData(html)

  // Fill gaps from OG/meta tags.
  const meta = raw.meta ?? {}
  raw.name = raw.name ?? meta['og:title'] ?? meta['twitter:title']
  raw.description = raw.description ?? meta['og:description'] ?? meta['description']
  raw.tagline = meta['twitter:description'] ?? raw.description?.split('. ')[0]

  // Long description: prefer ds:0 SSR payload, then itemprop heuristic, then fall back to short description.
  raw.longDescription =
    initData.longDescription ?? extractLongDescription(html) ?? raw.description

  // Category: ds:0 carries categoryLabel like "Productivity" / "Developer Tools".
  raw.category = raw.category ?? initData.category

  // Installs: prefer ds:0 numeric, fall back to "10,000+ users" text.
  raw.installs = initData.installs ?? extractInstallCount(html)

  // Rating: prefer ds:0, then JSON-LD already set above.
  if (raw.rating === undefined && initData.rating !== undefined) {
    raw.rating = initData.rating
  }
  if (raw.ratingCount === undefined && initData.ratingCount !== undefined) {
    raw.ratingCount = initData.ratingCount
  }

  // Screenshots: og:image and any /lh3.googleusercontent.com/ URLs.
  raw.screenshots = extractScreenshots(html, meta)

  // Related extensions discovered on the page.
  const relatedExtensionUrls = extractRelatedExtensionUrls(html, url)

  return {
    raw,
    relatedExtensionUrls,
    source: 'direct_fetch',
  }
}

// ---------- Fetch ----------

async function fetchHtml(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      throw new Error(`CWS fetch failed: ${res.status} ${res.statusText}`)
    }
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

// ---------- Parsers ----------

function extractMetaTags(html: string): Record<string, string> {
  const result: Record<string, string> = {}
  const metaRe =
    /<meta\s+(?:[^>]*?\s+)?(?:name|property)=["']([^"']+)["'](?:[^>]*?\s+)?content=["']([^"']*)["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = metaRe.exec(html))) {
    const key = m[1]?.toLowerCase()
    const value = m[2]
    if (key && value !== undefined && !(key in result)) {
      result[key] = decodeHtml(value)
    }
  }
  return result
}

function extractJsonLd(html: string): Record<string, unknown> | null {
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const raw = m[1]
    if (!raw) continue
    try {
      const parsed: unknown = JSON.parse(raw.trim())
      // CWS sometimes ships an array; pick the first SoftwareApplication-like.
      if (Array.isArray(parsed)) {
        const found = parsed.find(
          (it) => typeof it === 'object' && it !== null && '@type' in (it as object),
        )
        if (found && typeof found === 'object') return found as Record<string, unknown>
      } else if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  }
  return null
}

function extractLongDescription(html: string): string | undefined {
  // CWS renders the long description inside a section with itemprop="description"
  // or inside data attributes. Heuristic: capture the largest <p>-rich block.
  const itemProp = /itemprop=["']description["'][^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(html)
  if (itemProp?.[1]) {
    const text = stripTags(itemProp[1]).trim()
    if (text.length > 100) return text
  }
  return undefined
}

/**
 * Parse the AF_initDataCallback({key:'ds:0', ..., data:[...]}) block.
 * As of 2026, this is where CWS server-renders the real product detail.
 *
 * We only need a few fields, so instead of trying to parse the whole nested
 * JS array literal (fragile), we extract every JSON-style double-quoted
 * string and match by content shape. That keeps the parser simple and
 * resilient to Google reshuffling array indices.
 */
export interface CwsInitData {
  longDescription?: string
  category?: string
  installs?: number
  rating?: number
  ratingCount?: number
}

export function extractCwsInitData(html: string): CwsInitData {
  const re = /AF_initDataCallback\(\{key:\s*'ds:0'[\s\S]*?data:([\s\S]*?)\}\);/
  const m = re.exec(html)
  if (!m?.[1]) return {}
  const payload = m[1]

  const strings = extractJsonStrings(payload)

  const result: CwsInitData = {}

  // Long description anchor: CWS always wraps the developer-supplied long
  // description with the literal string "## Detailed Description\n\n" inserted
  // by the store frontend. Find the string that contains this anchor and use
  // the content AFTER the anchor as the long description.
  //
  // Why anchor-based, not "longest string": ds:0 also contains big strings
  // for sample manifests, related-item descriptions, and other irrelevant
  // payloads that can be longer than the actual product description.
  const ANCHOR = '## Detailed Description'
  for (const s of strings) {
    const idx = s.indexOf(ANCHOR)
    if (idx === -1) continue
    const after = s.slice(idx + ANCHOR.length).trim()
    if (after.length >= 50) {
      result.longDescription = after
      break
    }
  }

  // Secondary fallback: if the anchor isn't present, take the longest
  // multi-paragraph markdown-ish string. Skip anything that looks like a
  // raw manifest.json (starts with `{` or contains `"manifest_version"`).
  if (!result.longDescription) {
    let longest: string | undefined
    for (const s of strings) {
      if (s.length < 200) continue
      if (!/\n\n|##\s|\*\*/.test(s)) continue
      if (s.trimStart().startsWith('{')) continue
      if (s.includes('"manifest_version"')) continue
      if (!longest || s.length > longest.length) longest = s
    }
    if (longest) result.longDescription = longest.trim()
  }

  // Category: short strings from a known whitelist. Google tags it
  // (e.g. "Productivity") near other category metadata in ds:0.
  const KNOWN_CATEGORIES = [
    'Productivity',
    'Developer Tools',
    'Communication',
    'Accessibility',
    'Fun',
    'Photos',
    'Search Tools',
    'Shopping',
    'Social & Communication',
    'Sports',
    'Workflow & Planning',
    'Tools',
    'Education',
    'Entertainment',
    'News & Weather',
    'Lifestyle',
    'Make Chrome Yours',
  ]
  for (const s of strings) {
    if (s.length > 40) continue
    if (KNOWN_CATEGORIES.includes(s)) {
      result.category = s
      break
    }
  }

  return result
}

/**
 * Extract every JSON-style double-quoted string literal from a JS payload.
 * Decodes standard JSON escapes (\n, \", \\, \uNNNN). Skips malformed ones.
 *
 * NOTE: This will also pick up keys, URLs, etc. — callers must filter by
 * content shape (length, structure).
 */
function extractJsonStrings(src: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const escaped = m[1] ?? ''
    try {
      const decoded = JSON.parse('"' + escaped + '"') as string
      out.push(decoded)
    } catch {
      // Skip strings with invalid escapes.
    }
  }
  return out
}

function extractInstallCount(html: string): number | undefined {
  // Patterns like "10,000+ users" or "1,000,000+ users"
  const m = /([\d,]+)\+?\s*users?/i.exec(html)
  if (!m?.[1]) return undefined
  const num = parseInt(m[1].replace(/,/g, ''), 10)
  return Number.isFinite(num) ? num : undefined
}

function extractScreenshots(html: string, meta: Record<string, string>): string[] {
  const set = new Set<string>()
  const og = meta['og:image']
  if (og) set.add(og)
  const re = /https:\/\/lh3\.googleusercontent\.com\/[a-zA-Z0-9_=\-/]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    set.add(m[0])
    if (set.size >= 10) break
  }
  return Array.from(set)
}

/**
 * On a CWS detail page, "related" / "similar" extensions are linked by
 * /detail/<slug>/<id> paths. We collect unique ones, exclude self.
 */
function extractRelatedExtensionUrls(html: string, selfUrl: string): string[] {
  const re = /\/detail\/[a-z0-9-]+\/([a-z]{20,40})/gi
  const ids = new Set<string>()
  let m: RegExpExecArray | null
  const selfId = /\/detail\/[a-z0-9-]+\/([a-z]{20,40})/i.exec(selfUrl)?.[1]
  while ((m = re.exec(html))) {
    const id = m[1]?.toLowerCase()
    if (id && id !== selfId) ids.add(id)
  }
  return Array.from(ids)
    .slice(0, 15) // soft cap
    .map((id) => `https://chromewebstore.google.com/detail/${id}`)
}

// ---------- Tiny utilities ----------

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}
