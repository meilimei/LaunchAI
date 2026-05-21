/**
 * Browser agent loop — bounded computer-use.
 *
 * Inputs:
 *   - goal: natural-language description of the task to perform
 *   - context: structured data the goal references (e.g. post body, target subreddit)
 *   - page:  Playwright Page (already pointed at a sensible start URL)
 *
 * Loop:
 *   observe → LLM picks one tool → execute → repeat → finish.
 *
 * Bounds:
 *   - max steps (default 25)
 *   - max wallclock (default 90s)
 *   - LLM cost is tracked per step
 *
 * Outputs:
 *   - status:      'completed' | 'failed' | 'aborted'
 *   - trajectory:  full step log (input + tool call + observation)
 *   - finalSummary
 *   - finalOutput (whatever the agent returned via `finish.output`)
 *   - totalCostUsd
 *
 * Design notes:
 *   - Tool selection is a single structured LLM call per step (cheap).
 *   - The observation passed to the LLM is the *previous* tool's
 *     observation plus a fresh page description — keeps prompts short.
 *   - `finish` is the only legal exit. Hitting max-steps is a failure.
 */
import type { Page } from 'playwright'
import { generateStructured } from '@/lib/llm/client'
import { ToolCallSchema, describePage, executeTool, type ToolCall, type ToolResult } from './tools'
import { urlToPattern } from './url-pattern'
import type { SelectorHint } from './selector-hints'
import { renderHintsForPrompt } from './selector-hints'

export interface BrowserAgentInput {
  page: Page
  goal: string
  context?: Record<string, unknown>
  maxSteps?: number
  maxWallclockMs?: number
  /** Optional system prompt addendum, e.g. platform-specific etiquette. */
  systemAddendum?: string
  /**
   * Optional callback the agent invokes whenever it lands on a new URL
   * pattern. Returns historically-successful (tool, selector) pairs for
   * that URL pattern, which get injected into the step prompt as hints.
   * Production callers wire this to lookupSelectorHints; tests can omit
   * it (no hints injected).
   */
  hintLookup?: (urlPattern: string) => Promise<SelectorHint[]>
}

export interface BrowserAgentStep {
  index: number
  observationBefore: string
  /**
   * Page URL captured immediately before the tool call ran. Used by
   * selector telemetry to attribute (tool, selector) outcomes to the
   * correct page — we can't infer this reliably from observation strings
   * because failed steps don't include a URL.
   */
  urlBefore: string
  toolCall: ToolCall
  result: ToolResult
  durationMs: number
  costUsd: number
}

export interface BrowserAgentResult {
  status: 'completed' | 'failed' | 'aborted'
  trajectory: BrowserAgentStep[]
  finalSummary: string
  finalOutput?: Record<string, unknown>
  totalCostUsd: number
  totalDurationMs: number
}

const SYSTEM_PROMPT = `You are a careful browser-control agent operating a single Chromium tab on behalf of a logged-in user.

Rules you MUST follow:
- Output exactly ONE tool call per turn that conforms to the schema.
- Pick the smallest action that makes progress toward the goal.
- If the page shows a login form or CAPTCHA, do not try to bypass it. Use \`finish\` with success=false and explain "needs_reauth" or "captcha".
- Never click links that leave the current platform unless the goal requires it.
- Avoid destructive actions (delete, unfollow, change password) unless the goal explicitly says so.
- \`finish\` exits the loop. Read the goal ONCE more before deciding what to pass:
    - If the goal is MUTATING (post, comment, vote, follow, send a message, fill+submit a form, change a setting), success=true means the mutation HAS HAPPENED and you have observable evidence: a redirect to the new resource URL, a confirmation page, a "thanks" / "posted" toast, the new item appearing in a list, etc. Reading rules / sidebar / form pages is PREPARATION — not completion. If your draft \`summary\` contains phrases like "proceeding to ...", "about to ...", "ready to ...", "preflight passed" without "and posted" — that's a MID-TASK statement; do NOT call finish=true. Either continue the action, or call finish with success=false and explain what blocked you.
    - If the goal is READ-ONLY (extract data, summarize a thread, report on a competitor), success=true requires the requested data to be present in \`output\`.
    - If you cannot complete the goal (login wall, rule violation, missing flair, hit the step budget), call finish with success=false and concrete evidence in \`summary\` and/or \`output.blocked_reason\`.
- Prefer Playwright role-based locators (e.g. role=button[name="Submit"]) over fragile CSS class chains.
- For READING the main content of a page (article body, post body, rules text, comment thread, anything article-shaped), prefer \`read_main_content\` — a generic Mozilla-Readability-based extractor that strips nav/sidebar/footer chrome automatically, no selector required. It works on most platforms out of the box.
- Use \`extract_text\` with a specific selector only when (a) \`read_main_content\` returned ok=false / not enough content, or (b) you specifically need a region Readability skips (sidebar, header banner, a small inline element). Selectors like \`.side\`, \`aside\`, \`[role="complementary"]\` for sidebars; selector=body is a last resort and almost always gives you site chrome instead of content.
- \`describe_page\`, \`extract_text\`, and \`read_main_content\` all inspect the SAME page state from different angles (interactive elements / raw body text / readable article). They are complementary, NOT different sources of truth. Alternating between them does not fetch fresh content; once you have seen the page from each relevant angle, you have everything you can get from this page — act on it or call \`finish\`.
- The step prompt may include a "MOST RECENT READ CONTENT" section. That is the literal text from your most recent successful \`read_main_content\` or \`extract_text\` on the current page. READ IT before deciding to read again. If it already contains the information the goal asks for, USE it — do not re-read just because the page observation refreshed.
- \`extract_text\` reads the DOM via \`innerText\`. It returns the FULL text content of the matched element regardless of scroll position. Pressing End / PageDown does NOT change what the next \`extract_text\` or \`read_main_content\` will return.
- Do NOT call any tool twice in a row with identical arguments, and do NOT call the same (tool, arguments) more than 3 times across the recent trajectory. If the same call has produced a stable observation, treat that observation as canonical and decide — either take a different action or finish.
- The \`navigate\` observation reports the FINAL URL the browser landed on. Platforms often redirect (login walls, SPA route normalization, /about/X → /mod/X consolidation, mobile redirects). If the observation shows a different URL than you requested, that IS the real page now — call \`describe_page\` to inspect what you got, do NOT keep retrying the same navigate. The redirect target may still contain what you need.
- If \`INTERACTIVE ELEMENTS\` is empty, the page may need scrolling. Try \`press\` with key="End" or "PageDown", then describe again. If a second describe still shows nothing actionable, call \`finish\` with success=false and evidence describing what BODY TEXT showed.
- \`describe_page\` lists each anchor (\`a\`) with its resolved URL after a \`→\` arrow, e.g. \`a "permalink" → https://old.reddit.com/r/sub/comments/abc/title/xyz/\`. Use this when the goal asks you to capture a link — read the URL directly from the description rather than clicking the link and reading \`page.url()\` (which costs an extra navigation and risks losing the parent page's context).
- \`describe_page\` includes a "STATUS MESSAGES" section when the page has any visible alerts, errors, or toasts (role=alert, .error, .notification, etc.). Check this section before concluding a submit/save action succeeded: banners like "you are doing that too much", "please solve this captcha", or "your submission is being held for review" are the authoritative signal that the action DID NOT land, even if the click returned ok.
- Evidence in \`finish.summary\` and \`finish.output\` MUST be grounded in observations your tools actually returned in THIS trajectory. Do NOT hallucinate page state from priors — "new accounts usually can't post", "rate limits are common", "the textarea is probably empty now" are GUESSES, not observations. If the page state is ambiguous, either run one more observation tool (describe_page / extract_text) to verify, or finish success=false with blocked_reason='unknown' and evidence quoting what you ACTUALLY saw (e.g. "only the click observation is available; no describe_page was run after submit"). A wrong-but-confident evidence string is WORSE than an honest "unverified" — it poisons downstream analytics and account-state transitions.
- You have a hard step budget. The step prompt tells you how many steps remain. When fewer than 3 remain and the goal is not yet done, call \`finish\` with success=false and clear evidence rather than gambling on more attempts.
- Do NOT invent URLs; navigate only to URLs that appear in the page or are explicitly given in the goal.`

const DEFAULT_MAX_STEPS = 25
const DEFAULT_MAX_WALLCLOCK_MS = 90_000

export async function runBrowserAgent(
  input: BrowserAgentInput,
): Promise<BrowserAgentResult> {
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS
  const maxWallclockMs = input.maxWallclockMs ?? DEFAULT_MAX_WALLCLOCK_MS
  const startedAt = Date.now()

  const trajectory: BrowserAgentStep[] = []
  let totalCostUsd = 0
  let lastObservation = await describePage(input.page)
  // The agent's working memory is otherwise wiped each step by describePage.
  // Persist the most recent successful content read so it isn't forgotten on
  // the very next turn (e.g. step N reads rules, step N+1 overwrites
  // observation with describePage and the rules vanish from view).
  // Captures both extract_text and read_main_content output.
  let lastRead: {
    source: string
    observation: string
    stepIndex: number
  } | null = null
  // Cached hints for the current URL pattern. Refreshed lazily when the
  // pattern changes (after navigate / SPA route change) to avoid hitting
  // the DB every step.
  let learnedHints: SelectorHint[] = []
  let lastHintPattern: string | null = null

  for (let i = 0; i < maxSteps; i++) {
    if (Date.now() - startedAt > maxWallclockMs) {
      return finalize('aborted', 'wallclock budget exceeded', undefined, trajectory, totalCostUsd, startedAt)
    }

    // Capture the URL at the start of THIS step so telemetry attributes
    // the upcoming (tool, selector) call to the right page.
    const urlBefore = input.page.url()

    // Refresh learned hints when the URL pattern changes. Tested at every
    // step (cheap string compare) but DB hit only when the pattern is new.
    const patternNow = urlToPattern(urlBefore)
    if (patternNow !== lastHintPattern) {
      learnedHints = input.hintLookup
        ? await input.hintLookup(patternNow).catch(() => [])
        : []
      lastHintPattern = patternNow
    }

    // Loop guard: if the recent window has the same tool+args repeating,
    // the agent is wasting budget. Surface this in the step prompt so it
    // must change strategy on this turn.
    const stuckOnLoop = detectStuckLoop(trajectory)

    const stepStartedAt = Date.now()

    const prompt = buildStepPrompt({
      goal: input.goal,
      context: input.context,
      observation: lastObservation,
      lastRead,
      learnedHints,
      history: trajectory.slice(-4),
      stepIndex: i,
      stepsRemaining: maxSteps - i,
      stuckOnLoop,
    })

    const { data: toolCall, usage } = await generateStructured(
      'extractor',
      ToolCallSchema,
      prompt,
      {
        system: input.systemAddendum
          ? `${SYSTEM_PROMPT}\n\nPLATFORM NOTES:\n${input.systemAddendum}`
          : SYSTEM_PROMPT,
        temperature: 0.1,
        maxTokens: 600,
      },
    )

    totalCostUsd += usage.costUsd

    // Short-circuit redundant page-reads on the same URL. Observed failure
    // mode: the agent drafts a comment, re-reads the thread, drafts again,
    // re-reads again — 5 round-trips of read_main_content + extract_text on
    // the same old.reddit post. The page content hasn't changed between
    // these calls. Re-executing them burns ~1-2s of Playwright work and
    // bloats `lastRead` with identical text.
    //
    // When the model picks a read tool it has already run successfully at
    // this URL, we synthesize the observation from the cache and tell it
    // explicitly there's no new content. The step still counts (so finite
    // budget still bounds runaway loops) but costs nothing real.
    const cachedRead = findCachedRead(trajectory, urlBefore, toolCall)
    const result = cachedRead
      ? {
          ok: true,
          observation:
            `[cached — ${toolCall.tool} on ${urlBefore} already ran at step ${cachedRead.stepIndex + 1}; ` +
            `page content has not changed. Use the MOST RECENT READ CONTENT section above. ` +
            `Do NOT re-read — act on what you have, or call \`finish\`.]\n\n` +
            cachedRead.observation,
        }
      : await executeTool(input.page, toolCall)

    trajectory.push({
      index: i,
      observationBefore: lastObservation,
      urlBefore,
      toolCall,
      result,
      durationMs: Date.now() - stepStartedAt,
      costUsd: usage.costUsd,
    })

    if (toolCall.tool === 'finish') {
      return finalize(
        toolCall.success ? 'completed' : 'failed',
        toolCall.summary,
        toolCall.output,
        trajectory,
        totalCostUsd,
        startedAt,
      )
    }

    // Persist the most recent successful content read so the LLM keeps seeing
    // it even after subsequent describe_page calls overwrite lastObservation.
    if (toolCall.tool === 'extract_text' && result.ok) {
      lastRead = {
        source: `extract_text selector=${toolCall.selector ?? 'body'}`,
        observation: result.observation,
        stepIndex: i,
      }
    } else if (toolCall.tool === 'read_main_content' && result.ok) {
      lastRead = {
        source: 'read_main_content',
        observation: result.observation,
        stepIndex: i,
      }
    }
    // A new page invalidates any cached read from the previous one.
    if (toolCall.tool === 'navigate') {
      lastRead = null
    }

    // Refresh observation for next step.
    lastObservation = result.ok ? await describePage(input.page) : result.observation
  }

  return finalize(
    'failed',
    `max steps (${maxSteps}) exceeded without finish`,
    undefined,
    trajectory,
    totalCostUsd,
    startedAt,
  )
}

function finalize(
  status: BrowserAgentResult['status'],
  finalSummary: string,
  finalOutput: Record<string, unknown> | undefined,
  trajectory: BrowserAgentStep[],
  totalCostUsd: number,
  startedAt: number,
): BrowserAgentResult {
  return {
    status,
    trajectory,
    finalSummary,
    finalOutput,
    totalCostUsd,
    totalDurationMs: Date.now() - startedAt,
  }
}

interface StepPromptInput {
  goal: string
  context?: Record<string, unknown>
  observation: string
  /**
   * The most recent successful read (extract_text or read_main_content) on
   * the current page. Surfaced as a dedicated prompt section so the LLM
   * doesn't forget useful page text it just retrieved.
   */
  lastRead: { source: string; observation: string; stepIndex: number } | null
  /**
   * (tool, selector) pairs that worked on similar pages in past runs.
   * Surfaced as hints — the LLM is free to ignore them and pick something
   * else if the page has changed shape.
   */
  learnedHints: SelectorHint[]
  history: BrowserAgentStep[]
  stepIndex: number
  stepsRemaining: number
  /** Non-null when the recent window shows the same tool+args repeating. */
  stuckOnLoop: { tool: string; detail: string } | null
}

function buildStepPrompt(input: StepPromptInput): string {
  const lines: string[] = []
  lines.push(`STEP ${input.stepIndex + 1} (steps remaining: ${input.stepsRemaining})`)
  lines.push(`\nGOAL:\n${input.goal}`)
  if (input.context && Object.keys(input.context).length > 0) {
    lines.push(`\nCONTEXT (data the goal references):\n${JSON.stringify(input.context, null, 2)}`)
  }
  if (input.history.length > 0) {
    lines.push(`\nRECENT HISTORY (most recent last):`)
    for (const h of input.history) {
      lines.push(
        `- ${h.toolCall.tool}: ${
          h.result.ok ? 'ok' : 'FAIL'
        } — ${h.result.observation.slice(0, 600).replace(/\n/g, ' ')}`,
      )
    }
  }
  lines.push(`\nCURRENT PAGE OBSERVATION:\n${input.observation}`)
  if (input.lastRead) {
    lines.push(
      `\nMOST RECENT READ CONTENT (from \`${input.lastRead.source}\`, captured at step ${input.lastRead.stepIndex + 1}):`,
    )
    // Cap at 5000 chars — enough for a full rules page or sidebar excerpt
    // without blowing the prompt budget. The full text is in the trajectory
    // file for human review.
    lines.push(input.lastRead.observation.slice(0, 5000))
    lines.push('(end of read content)')
  }
  if (input.learnedHints.length > 0) {
    lines.push(
      `\nLEARNED SELECTORS (worked on similar pages in past runs — try these first if they fit your goal, but feel free to use something else if the page has changed):`,
    )
    lines.push(renderHintsForPrompt(input.learnedHints))
  }
  if (input.stuckOnLoop) {
    lines.push(
      `\nWARNING: \`${input.stuckOnLoop.tool}\` with arguments (${input.stuckOnLoop.detail}) ` +
        `has been called repeatedly in the recent trajectory and the observation has stabilised. ` +
        `That is a loop — calling it again will return the same content.\n` +
        `If you are searching for content that isn't appearing:\n` +
        `  - The page may have it below your current view; try \`press\` with key="End" or "PageDown".\n` +
        `  - The body text may simply not contain it; accept what you have and decide.\n` +
        `If you are retrying \`navigate\` to the same URL hoping for a different page, the platform has redirected you and the obs URL is the real page; call \`describe_page\` once and work with what's there.\n` +
        `This turn you MUST do something different: pick a different tool, change arguments, scroll, or call \`finish\` with the evidence you already have. Do NOT repeat \`${input.stuckOnLoop.tool}\` with the same arguments.`,
    )
  }
  if (input.stepsRemaining <= 3) {
    lines.push(
      `\nBUDGET WARNING: only ${input.stepsRemaining} steps left. If the goal is not nearly done, ` +
        `call finish with success=false and clear evidence rather than gambling.`,
    )
  }
  lines.push(
    `\nPick exactly ONE next tool call. If the goal is already achieved or impossible, call \`finish\`.`,
  )
  return lines.join('\n')
}

/**
 * Returns a non-null marker when the agent is stuck in a loop. We look at a
 * sliding window of the most recent steps and flag any (tool, args) signature
 * that has been called ≥ LOOP_THRESHOLD times. This catches both:
 *   - back-to-back identical calls (AAA), and
 *   - oscillation between two stable views (ABABAB), e.g. alternating
 *     describe_page and extract_text on the same page.
 * The next-step prompt uses this to force a strategy change on this turn.
 */
const LOOP_WINDOW = 6
const LOOP_THRESHOLD = 3

function detectStuckLoop(
  trajectory: BrowserAgentStep[],
): { tool: string; detail: string } | null {
  if (trajectory.length < LOOP_THRESHOLD) return null
  const window = trajectory.slice(-LOOP_WINDOW)
  const counts = new Map<
    string,
    { tool: string; detail: string; count: number }
  >()
  for (const step of window) {
    const sig = signatureForLoopCheck(step.toolCall)
    const key = `${step.toolCall.tool}::${sig}`
    const entry = counts.get(key)
    if (entry) {
      entry.count++
    } else {
      counts.set(key, { tool: step.toolCall.tool, detail: sig, count: 1 })
    }
  }
  for (const v of counts.values()) {
    if (v.count >= LOOP_THRESHOLD) {
      return { tool: v.tool, detail: v.detail }
    }
  }
  return null
}

/**
 * Look for a previous successful read of this URL with the same tool+args.
 *
 * Constraints:
 *   - Only looks back to the most recent `navigate` (different page = no cache).
 *   - Only applies to the two genuine read tools (`read_main_content`,
 *     `extract_text`). `describe_page` and other tools must always run fresh
 *     because they reflect the page's interactive state, not its content.
 */
function findCachedRead(
  trajectory: BrowserAgentStep[],
  currentUrl: string,
  currentCall: ToolCall,
): { stepIndex: number; observation: string } | null {
  if (currentCall.tool !== 'read_main_content' && currentCall.tool !== 'extract_text') {
    return null
  }
  const currentSelector =
    currentCall.tool === 'extract_text' ? currentCall.selector ?? null : null

  for (let i = trajectory.length - 1; i >= 0; i--) {
    const step = trajectory[i]
    if (!step) continue
    // Crossed a navigate → anything before it is on a different page.
    if (step.toolCall.tool === 'navigate') return null
    if (step.urlBefore !== currentUrl) continue
    if (!step.result.ok) continue
    if (step.toolCall.tool !== currentCall.tool) continue

    if (step.toolCall.tool === 'extract_text') {
      const prevSelector = step.toolCall.selector ?? null
      if (prevSelector !== currentSelector) continue
    }
    return { stepIndex: step.index, observation: step.result.observation }
  }
  return null
}

function signatureForLoopCheck(call: ToolCall): string {
  switch (call.tool) {
    case 'navigate':
      return `url=${call.url}`
    case 'click':
      return `selector=${call.selector}`
    case 'type':
      return `selector=${call.selector} chars=${call.text.length} submit=${call.submit ?? false}`
    case 'press':
      return `key=${call.key}`
    case 'wait_for':
      return `selector=${call.selector}`
    case 'extract_text':
      return `selector=${call.selector ?? 'body'}`
    case 'describe_page':
      return 'describe_page'
    case 'read_main_content':
      return 'read_main_content'
    case 'finish':
      // finish exits the loop, never reached as "previous step"
      return 'finish'
  }
}
