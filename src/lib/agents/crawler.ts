import pRetry, { AbortError } from 'p-retry'
import { nanoid } from 'nanoid'
import { db } from '@/lib/db/client'
import { rawScrapes } from '@/lib/db/schema'
import { detectUrl, type UrlInfo } from '@/lib/crawl/url'
import { scrapeCwsPage } from '@/lib/crawl/cws'
import type {
  Agent,
  AgentContext,
  CrawlerOutput,
  ProductRaw,
} from './types'

/**
 * Crawler Agent.
 *
 * Orchestrates the deterministic strategy of "where to fetch from":
 *   1. Detect URL type (deterministic, no LLM).
 *   2. Dispatch to the right scraper (CWS / Playwright / API).
 *   3. Discover competitors (via "related" links on the page).
 *   4. Persist raw scrape to Postgres for replay.
 *
 * For v1 we only fully implement the CWS path. Generic web URLs are
 * scraped via a minimal fallback that grabs OG meta + first paragraph.
 * Playwright integration lands in Phase B-2.
 *
 * Decision events are emitted at every branch so the user sees:
 *   "Detected CWS URL → using direct fetch (cheaper than Playwright)"
 *   "Found 12 related extensions, taking top 10 as competitors"
 */

const COMPETITOR_LIMIT = 10
const COMPETITOR_FETCH_CONCURRENCY = 3

export const crawlerAgent: Agent<CrawlerOutput> = {
  name: 'crawler',

  async run(ctx: AgentContext): Promise<CrawlerOutput> {
    const startedAt = Date.now()
    const inputUrl = ctx.job.inputUrl

    // ---------- Step 1: detect URL type ----------
    const urlInfo = detectUrl(inputUrl)

    await ctx.emit({
      agent: 'crawler',
      step: 'detect_url',
      inputSummary: inputUrl,
      outputSummary: `${urlInfo.sourceType.toUpperCase()} (${urlInfo.productType})`,
      reasoning: explainRouting(urlInfo),
      rawOutput: urlInfo,
      durationMs: Date.now() - startedAt,
    })

    // ---------- Step 2: scrape main product ----------
    const productStartedAt = Date.now()

    let productRaw: ProductRaw
    let relatedUrls: string[] = []
    let sourceLabel: 'cws' | 'web' | 'github'

    if (urlInfo.sourceType === 'cws') {
      const result = await runWithRetry(() => scrapeCwsPage(inputUrl))
      productRaw = result.raw
      relatedUrls = result.relatedExtensionUrls
      sourceLabel = 'cws'
    } else {
      productRaw = await fallbackScrapeWeb(inputUrl)
      sourceLabel = urlInfo.sourceType
    }

    await persistRawScrape(ctx.job.id, sourceLabel, inputUrl, productRaw)

    await ctx.emit({
      agent: 'crawler',
      step: 'scrape_product',
      inputSummary: inputUrl,
      outputSummary: summarizeProduct(productRaw),
      reasoning:
        sourceLabel === 'cws'
          ? `Used direct CWS fetch (cheaper + faster than Playwright). Recovered ${productRaw.installs ?? '?'} installs, rating ${productRaw.rating ?? '?'}.`
          : `Used generic web fallback (OG/meta tags only).`,
      rawOutput: redactProduct(productRaw),
      durationMs: Date.now() - productStartedAt,
    })

    // ---------- Step 3: scrape competitors (CWS only in v1) ----------
    const competitors: CrawlerOutput['competitors'] = []
    if (urlInfo.sourceType === 'cws' && relatedUrls.length > 0) {
      const targets = relatedUrls.slice(0, COMPETITOR_LIMIT)

      await ctx.emit({
        agent: 'crawler',
        step: 'scrape_competitors_start',
        outputSummary: `Fetching ${targets.length} related extensions`,
      })

      const results = await mapWithConcurrency(
        targets,
        COMPETITOR_FETCH_CONCURRENCY,
        async (url) => {
          try {
            const r = await runWithRetry(() => scrapeCwsPage(url))
            await persistRawScrape(ctx.job.id, 'cws', url, r.raw)
            return { url, name: r.raw.name, raw: r.raw }
          } catch (err) {
            // Don't fail the whole pipeline if one competitor scrape fails.
            console.warn(`[crawler] competitor scrape failed for ${url}:`, err)
            return null
          }
        },
      )

      for (const r of results) {
        if (r) competitors.push(r)
      }

      await ctx.emit({
        agent: 'crawler',
        step: 'scrape_competitors_complete',
        outputSummary: `Captured ${competitors.length}/${targets.length} competitors`,
      })
    }

    return {
      productType: urlInfo.productType,
      product: {
        url: inputUrl,
        sourceType: urlInfo.sourceType,
        raw: productRaw,
      },
      competitors,
    }
  },
}

// ---------- Helpers ----------

function explainRouting(info: UrlInfo): string {
  switch (info.sourceType) {
    case 'cws':
      return `Detected Chrome Web Store URL (host: ${info.hostname}). Routing to direct-fetch CWS scraper instead of Playwright — same data, ~10x cheaper.`
    case 'github':
      return `Detected GitHub URL. Will pull README via raw.githubusercontent.com in a future phase; for v1 we use OG metadata only.`
    case 'web':
      return `Generic web URL (host: ${info.hostname}). Using minimal OG/meta fallback. Playwright fallback is not enabled in v1 Phase B-1.`
  }
}

function summarizeProduct(raw: ProductRaw): string {
  const parts: string[] = []
  if (raw.name) parts.push(`name="${raw.name}"`)
  if (raw.installs) parts.push(`${raw.installs.toLocaleString()} users`)
  if (raw.rating) parts.push(`${raw.rating}★`)
  if (raw.description) parts.push(`desc=${raw.description.length}chars`)
  return parts.length > 0 ? parts.join(', ') : 'no fields recovered'
}

/**
 * Decision events go to Redis pubsub for SSE — keep them small.
 * The full HTML lives in raw_scrapes table only.
 */
function redactProduct(raw: ProductRaw): Partial<ProductRaw> {
  const slim: Partial<ProductRaw> = { ...raw }
  delete slim.rawHtml
  return slim
}

async function runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(fn, {
    retries: 2,
    minTimeout: 1500,
    factor: 2,
    onFailedAttempt: (err) => {
      // Don't retry on 4xx (URL invalid, gone, etc.) — fail fast.
      const msg = err.message.toLowerCase()
      if (/\b4\d{2}\b/.test(msg)) {
        throw new AbortError(err.message)
      }
    },
  })
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++
      const item = items[i]
      if (item === undefined) continue
      results[i] = await fn(item, i)
    }
  })
  await Promise.all(workers)
  return results
}

async function persistRawScrape(
  jobId: string,
  sourceType: string,
  url: string,
  raw: ProductRaw,
): Promise<void> {
  try {
    await db.insert(rawScrapes).values({
      id: nanoid(),
      jobId,
      sourceType,
      sourceUrl: url,
      rawHtml: raw.rawHtml ?? null,
      parsedJson: redactProduct(raw),
    })
  } catch (err) {
    console.warn('[crawler] persistRawScrape failed:', err)
  }
}

/**
 * Minimal generic-web fallback: just grab OG/meta tags so non-CWS URLs
 * don't break the pipeline. Real Playwright integration is Phase B-2.
 */
async function fallbackScrapeWeb(url: string): Promise<ProductRaw> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 LaunchAI/0.1',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`fallback fetch failed: ${res.status}`)
  const html = await res.text()
  const meta: Record<string, string> = {}
  const re =
    /<meta\s+(?:[^>]*?\s+)?(?:name|property)=["']([^"']+)["'](?:[^>]*?\s+)?content=["']([^"']*)["'][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const k = m[1]?.toLowerCase()
    const v = m[2]
    if (k && v !== undefined && !(k in meta)) meta[k] = v
  }
  return {
    name: meta['og:title'] ?? meta['twitter:title'],
    description: meta['og:description'] ?? meta['description'],
    tagline: meta['twitter:description'],
    rawHtml: html,
    meta,
    screenshots: meta['og:image'] ? [meta['og:image']] : undefined,
  }
}
