/**
 * Selector telemetry inspector.
 *
 * Usage:
 *   pnpm dev:selectors                          # list all platforms with hints
 *   pnpm dev:selectors reddit                   # list all URL patterns for reddit
 *   pnpm dev:selectors reddit old.reddit.com/r/*\/about/rules
 *                                               # list all selectors for a specific URL pattern
 *   pnpm dev:selectors --prune                  # delete entries with 0 successes and >=3 failures
 *
 * Purpose:
 *   - audit what the agent has learned
 *   - spot patterns with mostly-failing selectors (prune candidates)
 *   - sanity-check urlToPattern normalization
 *
 * Why not just drizzle-studio: this gives platform-grouped, threshold-filtered
 * views tailored to the telemetry domain. Studio is a generic table browser.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from '../src/lib/db/client'
import { platformSelectorHints } from '../src/lib/db/schema'

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--prune')) {
    await prune()
    return
  }

  const [platform, urlPattern] = args

  if (!platform) {
    await listPlatforms()
    return
  }

  if (!urlPattern) {
    await listUrlPatterns(platform)
    return
  }

  await listSelectors(platform, urlPattern)
}

async function listPlatforms(): Promise<void> {
  const rows = await db
    .select({
      platform: platformSelectorHints.platform,
      patterns: sql<number>`count(distinct ${platformSelectorHints.urlPattern})`,
      entries: sql<number>`count(*)`,
      totalSuccess: sql<number>`sum(${platformSelectorHints.successCount})`,
      totalFailure: sql<number>`sum(${platformSelectorHints.failureCount})`,
    })
    .from(platformSelectorHints)
    .groupBy(platformSelectorHints.platform)
    .orderBy(platformSelectorHints.platform)

  if (rows.length === 0) {
    console.log('No selector telemetry recorded yet. Run an agent task first.')
    return
  }

  console.log('Platforms with learned selectors:\n')
  console.log('platform               | patterns | entries | success | failure')
  console.log('-----------------------+----------+---------+---------+--------')
  for (const r of rows) {
    console.log(
      [
        r.platform.padEnd(22),
        String(r.patterns).padStart(8),
        String(r.entries).padStart(7),
        String(r.totalSuccess).padStart(7),
        String(r.totalFailure).padStart(7),
      ].join(' | '),
    )
  }
  console.log('\nDrill into a platform: pnpm dev:selectors <platform>')
}

async function listUrlPatterns(platform: string): Promise<void> {
  const rows = await db
    .select({
      urlPattern: platformSelectorHints.urlPattern,
      entries: sql<number>`count(*)`,
      totalSuccess: sql<number>`sum(${platformSelectorHints.successCount})`,
      totalFailure: sql<number>`sum(${platformSelectorHints.failureCount})`,
      lastUsedAt: sql<Date>`max(${platformSelectorHints.lastUsedAt})`,
    })
    .from(platformSelectorHints)
    .where(eq(platformSelectorHints.platform, platform))
    .groupBy(platformSelectorHints.urlPattern)
    .orderBy(desc(sql`sum(${platformSelectorHints.successCount})`))

  if (rows.length === 0) {
    console.log(`No telemetry recorded for platform "${platform}".`)
    return
  }

  console.log(`URL patterns learned for ${platform}:\n`)
  for (const r of rows) {
    const age = formatAge(new Date(r.lastUsedAt))
    console.log(
      `${r.urlPattern}\n  ${r.entries} selector(s), ${r.totalSuccess} success / ${r.totalFailure} failure, last ${age}`,
    )
  }
  console.log(`\nDrill into a URL pattern: pnpm dev:selectors ${platform} "<url_pattern>"`)
}

async function listSelectors(platform: string, urlPattern: string): Promise<void> {
  const rows = await db
    .select()
    .from(platformSelectorHints)
    .where(
      and(
        eq(platformSelectorHints.platform, platform),
        eq(platformSelectorHints.urlPattern, urlPattern),
      ),
    )
    .orderBy(desc(platformSelectorHints.successCount))

  if (rows.length === 0) {
    console.log(`No telemetry for ${platform} @ ${urlPattern}.`)
    return
  }

  console.log(`Selectors learned for ${platform} @ ${urlPattern}:\n`)
  console.log('tool              | success | failure | last used          | selector')
  console.log('------------------+---------+---------+--------------------+---------')
  for (const r of rows) {
    console.log(
      [
        r.tool.padEnd(17),
        String(r.successCount).padStart(7),
        String(r.failureCount).padStart(7),
        formatDate(r.lastUsedAt).padEnd(18),
        r.selector,
      ].join(' | '),
    )
  }
}

async function prune(): Promise<void> {
  // Prune rows where the selector has NEVER worked (successCount = 0) AND
  // has failed at least 3 times. Those are selectors the agent tried, they
  // didn't pay off, and we don't want to keep surfacing them as hints.
  //
  // Rows with even one success are kept — the page might have been
  // mid-hydration once and the same selector works now. Three failures
  // before we give up is a reasonable "enough evidence" threshold.
  const deleted = await db
    .delete(platformSelectorHints)
    .where(
      and(
        eq(platformSelectorHints.successCount, 0),
        gte(platformSelectorHints.failureCount, 3),
      ),
    )
    .returning({ id: platformSelectorHints.id })

  console.log(`Pruned ${deleted.length} row(s) with 0 successes and ≥3 failures.`)
}

function formatAge(d: Date): string {
  const diffMs = Date.now() - d.getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('dev:selectors failed:', err)
    process.exit(1)
  })
