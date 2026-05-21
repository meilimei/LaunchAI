/**
 * Selector telemetry — record what works, surface what works.
 *
 * The agent's biggest historical pain is "I don't know which CSS selector
 * to try on this page." Teaching that per-platform inside manifests was
 * the original approach, but it doesn't scale: every new platform requires
 * a fresh round of trial-and-error.
 *
 * This module closes the loop. After every agent run we walk the trajectory
 * and increment per-(platform, urlPattern, tool, selector) success/failure
 * counters. Before every step on a new page, the agent fetches the top
 * working selectors for that URL pattern and surfaces them as hints in the
 * prompt — so the second time it sees a Reddit rules page, it doesn't have
 * to rediscover that `read_main_content` works.
 *
 * Selectors are stored at PLATFORM scope, not user scope: the HTML structure
 * of old.reddit.com is the same for everyone, so learning aggregates across
 * users.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '@/lib/db/client'
import { platformSelectorHints } from '@/lib/db/schema'
import { urlToPattern } from './url-pattern'
import type { BrowserAgentStep } from './agent'
import type { ToolCall } from './tools'

/**
 * Sentinel selector value for tools that don't take a selector
 * (read_main_content) or where the agent supplied no selector
 * (extract_text with empty selector → defaults to body). Using a sentinel
 * keeps the unique index well-defined.
 */
const NO_SELECTOR = '__none__'

/** Minimum chars in an extract observation to count it as a "useful" read. */
const MIN_USEFUL_EXTRACT_CHARS = 200

export interface SelectorHint {
  tool: string
  selector: string
  successCount: number
  failureCount: number
}

/**
 * Walk a completed trajectory and persist selector telemetry — which
 * (tool, selector) calls succeeded or failed at each URL pattern.
 *
 * Idempotent within a single trajectory: if the agent calls
 * `extract_text body` ten times on the same page, we increment the
 * counter once (otherwise spamming would inflate counts). De-duped at
 * the (urlPattern, tool, selector) granularity, with success=true winning
 * over success=false (a single hit is enough to call the selector
 * "working" for that page).
 *
 * Callers should invoke this exactly once per agent run.
 */
export async function recordTrajectoryHints(
  platform: string,
  trajectory: BrowserAgentStep[],
): Promise<void> {
  if (trajectory.length === 0) return

  const records = new Map<
    string,
    {
      platform: string
      urlPattern: string
      tool: string
      selector: string
      success: boolean
    }
  >()

  for (const step of trajectory) {
    const url = step.urlBefore
    if (!url) continue
    const pattern = urlToPattern(url)
    if (!pattern) continue

    const descriptor = describeCall(step.toolCall)
    if (!descriptor) continue // Skip tools we don't track (navigate, press, finish, describe_page)

    const success = isSuccessful(step.toolCall, step.result.ok, step.result.observation)

    const key = `${pattern}::${descriptor.tool}::${descriptor.selector}`
    const existing = records.get(key)
    if (existing) {
      existing.success = existing.success || success
    } else {
      records.set(key, {
        platform,
        urlPattern: pattern,
        tool: descriptor.tool,
        selector: descriptor.selector,
        success,
      })
    }
  }

  // Sequential upserts — small N (typically <30) and we want clear errors
  // if any single row fails rather than silent batch failure.
  for (const r of records.values()) {
    try {
      await db
        .insert(platformSelectorHints)
        .values({
          id: nanoid(),
          platform: r.platform,
          urlPattern: r.urlPattern,
          tool: r.tool,
          selector: r.selector,
          successCount: r.success ? 1 : 0,
          failureCount: r.success ? 0 : 1,
          lastUsedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            platformSelectorHints.platform,
            platformSelectorHints.urlPattern,
            platformSelectorHints.tool,
            platformSelectorHints.selector,
          ],
          set: r.success
            ? {
                successCount: sql`${platformSelectorHints.successCount} + 1`,
                lastUsedAt: new Date(),
              }
            : {
                failureCount: sql`${platformSelectorHints.failureCount} + 1`,
                lastUsedAt: new Date(),
              },
        })
    } catch (err) {
      // Telemetry is fire-and-forget — never let it break a successful run.
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[selector-hints] upsert failed for ${r.urlPattern}: ${message}`)
    }
  }
}

/**
 * Look up the top selectors learned for a given (platform, urlPattern).
 * Returns up to topN entries with net positive success-failure ratio,
 * sorted by success count descending. Excludes selectors that have failed
 * more often than they've succeeded.
 *
 * Returns an empty array when nothing is known about this URL pattern —
 * callers should treat that as "no hint, agent figures it out from system
 * prompt + page observation."
 */
export async function lookupSelectorHints(
  platform: string,
  urlPattern: string,
  topN = 5,
): Promise<SelectorHint[]> {
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
    .limit(topN * 2) // Over-fetch so we can filter and still hit topN

  return rows
    .filter((r) => r.successCount > r.failureCount)
    .slice(0, topN)
    .map((r) => ({
      tool: r.tool,
      selector: r.selector,
      successCount: r.successCount,
      failureCount: r.failureCount,
    }))
}

/**
 * Render a list of hints as compact lines for injection into the step
 * prompt. Empty input → empty string so callers can no-op cheaply.
 */
export function renderHintsForPrompt(hints: SelectorHint[]): string {
  if (hints.length === 0) return ''
  const lines = hints.map((h) => {
    const sel = h.selector === NO_SELECTOR ? '(no selector needed)' : `selector="${h.selector}"`
    const stats =
      h.failureCount > 0
        ? `${h.successCount} succ / ${h.failureCount} fail`
        : `${h.successCount} succ`
    return `- ${h.tool} ${sel} — ${stats}`
  })
  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// internals
// ────────────────────────────────────────────────────────────────────────────

/**
 * Map a tool call to (tool name, selector value used as cache key).
 * Returns null for tools that don't carry useful selector telemetry —
 * navigate URLs are too unique to learn from, press/describe_page/finish
 * have no selector dimension worth tracking.
 */
function describeCall(call: ToolCall): { tool: string; selector: string } | null {
  switch (call.tool) {
    case 'click':
      return { tool: 'click', selector: call.selector }
    case 'type':
      return { tool: 'type', selector: call.selector }
    case 'wait_for':
      return { tool: 'wait_for', selector: call.selector }
    case 'extract_text':
      return { tool: 'extract_text', selector: call.selector ?? NO_SELECTOR }
    case 'read_main_content':
      return { tool: 'read_main_content', selector: NO_SELECTOR }
    case 'navigate':
    case 'press':
    case 'describe_page':
    case 'finish':
      return null
  }
}

/**
 * "Did this tool call actually do useful work?" Distinct from result.ok
 * because Playwright considers many trivial outcomes successful (e.g.
 * extract_text body that returned 200 chars of nav junk). For
 * read-shaped tools we additionally require a content threshold.
 */
function isSuccessful(call: ToolCall, ok: boolean, observation: string): boolean {
  if (!ok) return false
  if (call.tool === 'extract_text' || call.tool === 'read_main_content') {
    return observation.length > MIN_USEFUL_EXTRACT_CHARS
  }
  return true
}
