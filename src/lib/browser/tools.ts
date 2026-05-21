/**
 * Computer-use tool vocabulary.
 *
 * The browser agent picks one of these per step. Each tool maps to a thin
 * wrapper over Playwright Page. Selectors prefer Playwright's role-based
 * locators where possible because they match how the LLM tends to describe
 * UI ("the button labeled Submit").
 *
 * Keep this list small. New tools should only be added when an existing one
 * cannot express the action.
 */
import type { Page } from 'playwright'
import { z } from 'zod'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'

export const ToolCallSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('navigate'),
    url: z.string().url(),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    tool: z.literal('click'),
    selector: z
      .string()
      .min(1)
      .describe(
        'Playwright locator string. Prefer role syntax e.g. role=button[name="Submit"], or a CSS selector.',
      ),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    tool: z.literal('type'),
    selector: z.string().min(1),
    text: z.string().min(1),
    submit: z.boolean().optional().describe('If true, press Enter after typing.'),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    tool: z.literal('press'),
    key: z.string().min(1).describe('Key name e.g. Enter, Escape, Tab.'),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    tool: z.literal('wait_for'),
    selector: z.string().min(1),
    timeoutMs: z.number().int().min(500).max(30_000).optional(),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    tool: z.literal('extract_text'),
    selector: z.string().min(1).optional(),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    tool: z.literal('read_main_content'),
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'Extract the main readable content of the current page (article body, post body, rules text, etc.) using Mozilla Readability heuristics. Skips nav/sidebar/footer chrome automatically without needing a selector.',
      ),
  }),
  z.object({
    tool: z.literal('describe_page'),
    reason: z.string().min(1).max(500),
  }),
  z.object({
    tool: z.literal('finish'),
    success: z.boolean(),
    summary: z.string().min(1).max(500),
    output: z.record(z.unknown()).optional(),
  }),
])

export type ToolCall = z.infer<typeof ToolCallSchema>

export interface ToolResult {
  ok: boolean
  observation: string
  error?: string
}

const SAFE_TIMEOUT_MS = 10_000

export async function executeTool(page: Page, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case 'navigate': {
        await page.goto(call.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        // SPAs (Ember/React) keep working after DOMContentLoaded — give the
        // page a chance to settle before the next describe_page sees stale DOM.
        await page
          .waitForLoadState('networkidle', { timeout: 5_000 })
          .catch(() => undefined)
        return { ok: true, observation: `navigated to ${page.url()}` }
      }
      case 'click': {
        await page.locator(call.selector).first().click({ timeout: SAFE_TIMEOUT_MS })
        return { ok: true, observation: `clicked ${call.selector}` }
      }
      case 'type': {
        const locator = page.locator(call.selector).first()
        await locator.fill(call.text, { timeout: SAFE_TIMEOUT_MS })
        if (call.submit) {
          await locator.press('Enter', { timeout: SAFE_TIMEOUT_MS })
        }
        return {
          ok: true,
          observation: `typed ${call.text.length} chars into ${call.selector}${call.submit ? ' and pressed Enter' : ''}`,
        }
      }
      case 'press': {
        await page.keyboard.press(call.key)
        return { ok: true, observation: `pressed ${call.key}` }
      }
      case 'wait_for': {
        await page
          .locator(call.selector)
          .first()
          .waitFor({ timeout: call.timeoutMs ?? SAFE_TIMEOUT_MS })
        return { ok: true, observation: `selector ${call.selector} appeared` }
      }
      case 'extract_text': {
        const text = call.selector
          ? await page.locator(call.selector).first().innerText({ timeout: SAFE_TIMEOUT_MS })
          : await page.innerText('body', { timeout: SAFE_TIMEOUT_MS })
        // Pages with heavy chrome (old.reddit nav, marketing footers, etc.)
        // can easily push real content past a small slice. Selector-targeted
        // calls already scope tightly so the smaller cap is fine; whole-body
        // calls need a much bigger window to actually surface content.
        const limit = call.selector ? 4000 : 12000
        const trimmed = text.trim().slice(0, limit)
        return { ok: true, observation: `extract_text:\n${trimmed}` }
      }
      case 'describe_page': {
        const observation = await describePage(page)
        return { ok: true, observation }
      }
      case 'read_main_content': {
        const observation = await readMainContent(page)
        return { ok: observation.ok, observation: observation.text }
      }
      case 'finish': {
        return {
          ok: call.success,
          observation: `finish:${call.success ? 'success' : 'failure'} — ${call.summary}`,
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, observation: `tool ${call.tool} failed: ${message}`, error: message }
  }
}

/**
 * Generic "give me the article" extractor that uses Mozilla's Readability
 * heuristics (the same engine that powers Firefox Reader View). Skips
 * navigation, sidebars, footers, ads, and anything that looks like chrome,
 * returning just the dense text region the page is actually about.
 *
 * Why this exists: every platform has different selectors for "main content"
 * (`div.content` on old.reddit, `article` on blogs, `[data-test-id=post]` on
 * LinkedIn, etc.). Without this tool, every manifest had to teach the agent
 * those selectors. With it, the agent can read article-shaped content on any
 * platform without per-platform configuration.
 *
 * Returns ok=false when the page has no readable region (e.g. a pure form
 * page, or a SPA that hasn't hydrated). In that case the agent should fall
 * back to `describe_page` or `extract_text` with a specific selector.
 */
export async function readMainContent(
  page: Page,
): Promise<{ ok: boolean; text: string }> {
  const url = page.url()
  // Let SPA hydration settle so we don't Readability over a skeleton.
  await page
    .waitForLoadState('networkidle', { timeout: 1500 })
    .catch(() => undefined)

  let html: string
  try {
    html = await page.content()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, text: `read_main_content: page.content() failed: ${message}` }
  }

  let dom: JSDOM
  try {
    dom = new JSDOM(html, { url })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, text: `read_main_content: jsdom parse failed: ${message}` }
  }

  // Readability mutates the document, so clone first to be safe if jsdom is
  // ever reused. Cheap on a one-shot dom anyway.
  const reader = new Readability(dom.window.document.cloneNode(true) as Document)
  const article = reader.parse()
  if (!article || !article.textContent) {
    return {
      ok: false,
      text: `read_main_content: no readable article region found at ${url}. Try \`describe_page\` or \`extract_text\` with a specific selector.`,
    }
  }

  // Collapse runs of whitespace; Readability returns text with original
  // newlines that bloat token counts without adding meaning to the LLM.
  const cleaned = article.textContent.trim().replace(/\s+/g, ' ')
  const limit = 12000
  const trimmed = cleaned.slice(0, limit)
  const truncatedNote = cleaned.length > limit ? ` (truncated from ${cleaned.length} chars)` : ''
  const title = (article.title || '').trim().slice(0, 200)
  return {
    ok: true,
    text: `read_main_content title="${title}" length=${cleaned.length}${truncatedNote}:\n${trimmed}`,
  }
}

/**
 * Cheap "what is on screen" summary — title, URL, visible interactive
 * elements with role + name. If the page is mid-hydration, retry once.
 * If still empty, fall back to a body-text excerpt so the LLM at least
 * sees what the page is saying.
 *
 * The LLM uses this to decide its next move.
 */
export async function describePage(page: Page): Promise<string> {
  const url = page.url()
  const title = await page.title().catch(() => '')

  // Give late-binding SPA components one more chance before snapshotting.
  await page
    .waitForLoadState('networkidle', { timeout: 1500 })
    .catch(() => undefined)

  let elements = await collectElements(page)
  if (elements.length === 0) {
    // Hydration race — wait a beat and retry.
    await page.waitForTimeout(1500)
    elements = await collectElements(page)
  }

  // Status / error banners are often NON-interactive (bare text in a
  // [role="alert"] or .error div) and therefore invisible to the element
  // collector. Without this the agent can click Submit, get a red "you are
  // doing that too much" banner, and then see a describe_page output that
  // has no sign the submission failed. Collecting these separately is
  // cheap and unblocks reliable post-action verification.
  const statusMessages = await collectStatusMessages(page)

  const lines = [`URL: ${url}`, `TITLE: ${title}`, 'INTERACTIVE ELEMENTS:']
  for (const el of elements) lines.push(`- ${el}`)
  if (statusMessages.length > 0) {
    lines.push('', 'STATUS MESSAGES (alerts / errors / toasts visible on the page):')
    for (const m of statusMessages) lines.push(`- ${m}`)
  }

  // Fallback when the page genuinely has no interactive elements visible:
  // dump a body-text excerpt so the LLM can read CTAs / instructions and
  // pick a useful next action (often: scroll, click a CTA link, retry, or
  // call finish with success=false + clear evidence).
  if (elements.length === 0) {
    const bodyText = await page
      .innerText('body', { timeout: 5_000 })
      .catch(() => '')
    const trimmed = bodyText.replace(/\s+/g, ' ').trim().slice(0, 1500)
    if (trimmed) {
      lines.push('', 'BODY TEXT (first 1500 chars, no interactive elements detected):')
      lines.push(trimmed)
    }
  }

  return lines.join('\n')
}

/**
 * Gather visible status/error/success banners. Most platforms surface these
 * as non-interactive text blocks, so the interactive-element collector
 * misses them. Patterns covered:
 *   - ARIA: role=alert / role=status / aria-live regions
 *   - Common Bootstrap / Tailwind classes: .alert, .error, .notification,
 *     .flash, .toast, .status
 *   - Reddit-specific: the `.error` span inline with form errors
 * We dedupe identical messages and cap length per message.
 */
async function collectStatusMessages(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const selector = [
        '[role="alert"]',
        '[role="status"]',
        '[aria-live="assertive"]',
        '[aria-live="polite"]',
        '.alert',
        '.error',
        '.notification',
        '.flash',
        '.flash-notice',
        '.flash-message',
        '.toast',
        '.status-message',
      ].join(',')
      const nodes = Array.from(document.querySelectorAll(selector)) as HTMLElement[]
      const seen = new Set<string>()
      const out: string[] = []
      for (const el of nodes) {
        if (out.length >= 10) break
        const rect = el.getBoundingClientRect()
        const zeroArea = rect.width === 0 && rect.height === 0
        if (zeroArea && el.offsetParent === null) continue
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
        if (!text) continue
        if (text.length > 400) continue
        if (seen.has(text)) continue
        seen.add(text)
        out.push(text)
      }
      return out
    })
    .catch(() => [] as string[])
}

async function collectElements(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      // 150 is enough for most pages including comment-dense Reddit threads.
      // (The old 80 was exhausted by Reddit's header alone — 60+ subreddit
      // quick-links, search, user nav, flair sidebar — so the comment area
      // never made it into the agent's view.)
      const max = 150
      const out: string[] = []
      // Broader selector — add labels, contenteditable, common ARIA roles
      // that come up in form-heavy pages. order matters: form-y things first.
      const nodes = Array.from(
        document.querySelectorAll(
          [
            'input',
            'textarea',
            'select',
            'button',
            'a',
            'label',
            '[contenteditable="true"]',
            '[role="button"]',
            '[role="link"]',
            '[role="textbox"]',
            '[role="combobox"]',
            '[role="searchbox"]',
            '[role="checkbox"]',
            '[role="switch"]',
            '[role="tab"]',
          ].join(','),
        ),
      ) as HTMLElement[]
      // Matches the most common page-chrome landmarks that should be skipped
      // when the agent is looking for main-content interactions. Platforms
      // using semantic HTML (nav/header/footer, ARIA role=banner|navigation|
      // contentinfo) get filtered. Platforms with old non-semantic markup
      // (old.reddit uses plain <div id="header">) slip through — the raised
      // element cap above compensates.
      const CHROME_SELECTOR =
        'nav, header, footer, [role="banner"], [role="navigation"], [role="contentinfo"]'
      for (const el of nodes) {
        if (out.length >= max) break
        if (el.closest(CHROME_SELECTOR)) continue
        const rect = el.getBoundingClientRect()
        // Visibility heuristic: skip only when the element has zero area
        // AND no offset parent (truly detached). This keeps elements that
        // are off-screen-but-rendered (below-the-fold form fields).
        const zeroArea = rect.width === 0 && rect.height === 0
        if (zeroArea && el.offsetParent === null) continue

        const tag = el.tagName.toLowerCase()
        const role = el.getAttribute('role') ?? tag
        // Render the type attr as `[type=submit]` rather than `[submit]`. The
        // shorter form was confusing agents into clicking `input[submit]` as
        // if it were a CSS selector — it parses as "input with attribute named
        // submit", which never matches anything, so Playwright times out.
        // The longer form is the actual valid CSS for that element AND still
        // tells the agent what type it is at a glance. Verified bite on HN
        // engage 2026-05-01: 2 wasted clicks before the agent recovered.
        const type = (el as HTMLInputElement).type ? `[type=${(el as HTMLInputElement).type}]` : ''
        const name =
          el.getAttribute('aria-label') ??
          el.getAttribute('placeholder') ??
          el.getAttribute('name') ??
          (el.innerText || el.getAttribute('value') || '').slice(0, 80)
        const id = el.id ? `#${el.id}` : ''
        const dataTestId = el.getAttribute('data-testid')
          ? `[data-testid="${el.getAttribute('data-testid')}"]`
          : ''
        // For anchors, surface the resolved href so the agent can capture
        // permalinks / URLs without an extra navigate. (.href returns the
        // absolute resolved URL even when the markup is relative.)
        // Truncate to keep the page summary compact on link-heavy pages.
        let href = ''
        if (tag === 'a') {
          const raw = (el as HTMLAnchorElement).href || ''
          if (raw) href = ` → ${raw.length > 200 ? raw.slice(0, 200) + '…' : raw}`
        }
        out.push(`${role}${type}${id}${dataTestId} "${name.trim()}"${href}`)
      }
      return out
    })
    .catch(() => [] as string[])
}
