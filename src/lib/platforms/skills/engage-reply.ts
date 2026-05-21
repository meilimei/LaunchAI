/**
 * engage-reply skill — the reusable "leave one helpful reply on someone
 * else's post" workflow, distilled from the Reddit warmup experience
 * (see memory: "Engage action maturity pattern").
 *
 * A "skill" here is a deterministic goalTemplate builder: platforms
 * provide the parts that genuinely differ (voice, selectors, verification
 * markers, candidate source), and the skill renders them into a stable
 * WORKFLOW the browser agent follows. The anti-hallucination / mandatory-
 * verification / atomic-type-then-submit guarantees live IN ONE PLACE
 * rather than being copy-pasted across N platforms (where they drift).
 *
 * Ownership:
 *   - Platform manifest decides: WHAT to say (voice), WHERE to click
 *     (selectors), HOW to verify (positive markers + URL shape), WHICH
 *     banners are negative (keywords).
 *   - This skill decides: step order, verification is mandatory, permalink
 *     must come from href surfaced by describe_page, evidence must be
 *     observation-backed.
 *
 * When adding a new platform's engage action:
 *   1. Fetch candidates server-side (platform's public API → permalinks).
 *   2. Provide a VOICE_RULES block (tone, forbidden phrases, self-review).
 *   3. Identify the reply textarea + submit button selectors.
 *   4. Identify platform-specific positive signals (elements that ONLY
 *      appear adjacent to your OWN post — e.g. "edit"/"delete" on Reddit
 *      and HN, "unvote" on HN).
 *   5. Identify the URL pattern of a reply permalink on this platform.
 *   6. Call `buildEngageReplyGoal({ ... })` from the action's goalTemplate.
 *
 * Not (yet) in scope:
 *   - Platforms where engaging requires a separate /reply page (the
 *     skill currently assumes an inline reply form on the thread page,
 *     which covers old.reddit, HN story pages, most forums). When the
 *     first such platform comes up, add an optional `openReplyFormStep`
 *     slot.
 */

export interface EngageReplySkillOptions {
  /**
   * Human-readable platform name. Surfaces in the first line of the goal
   * ("Leave one helpful reply on {platformName} ...") and in agent
   * reasoning. Examples: "Reddit", "Hacker News".
   */
  platformName: string

  /**
   * What kind of reputation this engage builds. Rendered in the opening
   * line. Examples: "comment karma", "HN karma", "your IH community rep".
   * Keep it short — it's one noun phrase.
   */
  reputationNoun: string

  /**
   * Platform-specific CONTEXT lines rendered before the candidates block.
   * One string per line. Keep each line narrow (topic, count, audience
   * notes). The skill already prints the task and workflow; this slot
   * is for payload-driven facts the agent should see before picking.
   *
   * Example (Reddit): [
   *   "target subreddits (allowlist): AskReddit, NoStupidQuestions",
   *   "topic (advisory): none",
   *   "replies to post this run: 1",
   * ]
   */
  contextLines: string[]

  /**
   * Pre-rendered candidate list. The skill does NOT fetch candidates;
   * the caller fetches them via the platform's API and formats them as
   * a markdown-ish list. Include at minimum: index number, title, url,
   * a short body snippet / question summary, and freshness.
   *
   * A typical block looks like:
   *   [1] r/NoStupidQuestions · 2h · 89 comments
   *       https://old.reddit.com/r/NoStupidQuestions/comments/.../
   *       Title: How often do regular people actually get arrested for ...
   *       Body: Is it a realistic fear that someone doing casual piracy ...
   */
  candidatesBlock: string

  /**
   * Extra hard constraints specific to this platform. The skill already
   * enforces the universal ones (reply only from candidate list, 1 reply,
   * no self-promo, no links, no @mentions). This slot is for additions.
   *
   * Example (Reddit): ["Do not reply in subs not on the allowlist."]
   * Example (HN): ["Do not reply to dead / flagged / [dead] items."]
   */
  additionalHardConstraints?: string[]

  /**
   * The long voice / style / self-review block specific to this platform.
   * This is the BIGGEST per-platform artifact — Reddit wants casual
   * lowercase fragments, HN wants technical substance, IH wants builder-
   * to-builder tone. The skill renders this verbatim between constraints
   * and workflow.
   *
   * Keep voice rules platform-authored — a shared voice block leaks
   * "helpful chatbot" register that every community downvotes in its
   * own way.
   */
  voiceRules: string

  /** Selectors the agent uses for the submit flow. */
  selectors: {
    /**
     * Locator for the reply textarea on the thread page. Prefer a stable
     * attribute selector (`textarea[name='text']`) over class chains.
     */
    replyTextarea: string
    /**
     * Playwright locator for the submit button. Prefer role-based:
     *   role=button[name="save"]
     *   role=button[name="add comment"]
     * Plain CSS works too if the element is a real <button> or <input>
     * with a stable attribute.
     */
    submitButton: string
    /**
     * Optional list of wrong selectors the agent tends to try. Surfacing
     * these negatively in the prompt saves 1-2 wasted 10s timeouts per
     * run. Example for Reddit: ["button[name='save']", "button[submit]",
     * "button[type='submit']"]. Omit if there's no known trap.
     */
    knownWrongSubmitSelectors?: string[]
  }

  /**
   * How to prove YOUR comment landed, using only what describe_page
   * surfaces. The agent scans INTERACTIVE ELEMENTS for these markers.
   * Each string is a SUBSTRING the agent should look for as-is.
   *
   * A reliable positive marker is something the platform renders ONLY
   * next to your own content. Examples:
   *   Reddit: `a "edit"` and `a "delete"` adjacent to your comment
   *   HN:     `a "edit"` + `a "delete"` (only for first 2h on new comments)
   *   HN:     `a "unvote"` (your own comments and ones you upvoted)
   *
   * Provide the MOST SPECIFIC markers first; the agent treats finding
   * any ONE of them as sufficient.
   */
  positiveMarkers: string[]

  /**
   * An example of what YOUR reply's permalink looks like in the
   * describe_page anchor output. The skill uses this as a template the
   * agent matches against — so include the full shape with a concrete
   * placeholder for the comment id.
   *
   * Examples:
   *   Reddit: `a "permalink" → https://old.reddit.com/r/<sub>/comments/<post>/<slug>/<comment>/`
   *   HN:     `a "<timestamp>" → https://news.ycombinator.com/item?id=<comment_id>` (where <comment_id> is a NEW id, not the story's)
   */
  replyPermalinkShape: string

  /**
   * Platform-specific phrases that appear in error banners when the
   * submission was refused (rate limit, captcha, manual review, etc.).
   * The skill asks the agent to scan the STATUS MESSAGES section of
   * describe_page for any of these. Each keyword is matched as a
   * substring, case-insensitive on the agent side.
   *
   * Examples (Reddit): ["doing that too much", "please solve this captcha",
   *   "being reviewed", "held for moderator review"]
   * Examples (HN): ["You're posting too fast", "Please slow down",
   *   "Unknown or expired link"]
   */
  negativeBannerKeywords: string[]
}

/**
 * Render a complete goal prompt for an engage-reply action.
 *
 * The returned string is meant to be handed straight to runBrowserAgent
 * (via ActionRecipe.goalTemplate). The adapter appends the block-detection
 * addendum afterward, so the skill deliberately does NOT include it.
 */
export function buildEngageReplyGoal(opts: EngageReplySkillOptions): string {
  const {
    platformName,
    reputationNoun,
    contextLines,
    candidatesBlock,
    additionalHardConstraints = [],
    voiceRules,
    selectors,
    positiveMarkers,
    replyPermalinkShape,
    negativeBannerKeywords,
  } = opts

  // Stable context block — renders the payload-driven facts.
  const contextBlock = contextLines.length
    ? `CONTEXT:\n${contextLines.map((l) => `  ${l}`).join('\n')}\n\n`
    : ''

  // Universal constraints + platform additions. Wording is deliberate —
  // "break any of these and finish success=false" makes the rules sharp
  // rather than advisory.
  const universalConstraints = [
    'Only reply to a post from the CANDIDATES list above. Do not browse for others.',
    'Exactly 1 reply per target post. Never thread-bomb.',
    'No links. No @mentions. No product names. No self-promotion.',
  ]
  const hardConstraints = [...universalConstraints, ...additionalHardConstraints]
    .map((c) => `  - ${c}`)
    .join('\n')

  // Submit-button step — optionally calls out known-wrong selectors so
  // the agent doesn't waste a 10s timeout trying them.
  const wrongSelectors = selectors.knownWrongSubmitSelectors?.length
    ? ` Wrong selectors that all FAIL on this platform: ${selectors.knownWrongSubmitSelectors
        .map((s) => `\`${s}\``)
        .join(', ')}.`
    : ''

  // Positive marker list — rendered as a bulleted list in the prompt so
  // the agent can cite the one it found.
  const positiveMarkerList = positiveMarkers.map((m) => `         - ${m}`).join('\n')

  // Negative keyword list — substring scan targets.
  const negativeKeywordList = negativeBannerKeywords
    .map((k) => `"${k}"`)
    .join(', ')

  return `Leave one helpful reply on ${platformName} to build ${reputationNoun}.

${contextBlock}CANDIDATES (pre-filtered server-side; do not browse for others):

${candidatesBlock}

HARD PROCESS CONSTRAINTS — break any of these and finish success=false.
${hardConstraints}

${voiceRules}

WORKFLOW:

  1. Pick ONE candidate from the list above whose post body / question
     lets you add EXACTLY ONE specific fact, number, year, tool, brand,
     observation, or analogy. If none qualify, call finish with
     success=false (see FINISH CONTRACT below).
  2. Navigate to that candidate's \`url\`.
  3. Call \`read_main_content\` ONCE to load the OP body + existing top
     comments. Your reply must react to what OP said and must NOT
     duplicate an existing comment. Do not re-read this page; the cache
     will reject duplicate reads.
  4. \`type\` your reply into \`${selectors.replyTextarea}\`. Self-review
     against the checklist in the \`reason\` field of this call. The
     \`type\` tool uses Playwright \`fill()\` which CLEARS and replaces
     — you get ONE attempt per submission, no iteration. If your draft
     can't pass self-review, navigate to a different candidate URL
     instead of typing.
  5. Click the submit button. The locator is \`${selectors.submitButton}\`.${wrongSelectors}
  6. MANDATORY: call \`describe_page\` immediately after step 5. You
     cannot skip this step and you cannot call \`finish\` before it.
     Do not reason about the outcome from priors ("new accounts
     probably fail", "it likely rate-limited") — your priors are
     unreliable; CHECK THE PAGE. Evaluate what the describe_page
     output shows:

       (6a) STATUS MESSAGES section contains any of: ${negativeKeywordList} →
            finish success=false, blocked_reason matches the text
            (rate_limit / captcha / manual_review), evidence = verbatim
            STATUS MESSAGE content.

       (6b) INTERACTIVE ELEMENTS contains any of these markers adjacent
            to your new comment (these render only for YOUR OWN content):
${positiveMarkerList}
            AND an anchor shaped like:
              ${replyPermalinkShape}
            with a real comment-id URL segment (not just the thread URL)
            → proceed to step 7.

       (6c) Neither 6a nor 6b applies → finish success=false,
            blocked_reason='unknown', evidence = summary of what the
            describe_page output ACTUALLY showed (URL, presence/absence
            of textarea, what was in INTERACTIVE ELEMENTS).

  7. Finish success=true with output={
       url: '<the comment permalink from step 6b>',
       replied: ['<same permalink>']
     }. The url field MUST be the comment permalink from step 6b, not
     the thread URL, not the candidate URL.

FINISH CONTRACT:
  - success=true ONLY if you posted a reply that passed self-review and
    verified it appeared on the page.
    output={ url: '<permalink of your reply>', replied: ['<permalink>'] }
  - success=false if NO candidate offered something specific you could
    add, OR your drafts kept failing self-review. This is a SOFT defer
    (next run gets a fresh candidate set ~1h later), NOT a moderator block.
    output={ blocked_reason: 'no_target',
             evidence: 'no suitable engage target: <one-line reason>' }

The url field is required by the finish validator — without it the run is
marked failed regardless of summary text.

Reminder: a bad comment produces negative karma / rep, which is strictly
worse than no comment. Finishing false is a GOOD outcome when content
quality is the constraint.`
}
