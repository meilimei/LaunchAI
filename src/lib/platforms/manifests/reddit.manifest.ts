/**
 * Reddit — declarative platform manifest with subreddit-aware actions.
 *
 * Status: ACTIVE. Revived 2026-05-26 after the three deprecation
 * preconditions (recorded in History below) were each addressed.
 *
 * History:
 *   2026-05-02 deprecate — autonomous Reddit posting deferred after probe
 *     brittleness (unauthenticated /user/<x>/about.json 404 under
 *     anti-scraping throttle) + Reddit's adversarial stance toward
 *     fresh-account AI content. dev-warmup.ts removed 'reddit' from
 *     VALID_PLATFORMS; manifest kept as draft-only output for the
 *     audience-mapper (PRD v1 F3) and as a reference subreddit-aware
 *     recipe shape for future platforms.
 *   2026-05-26 revive — three deprecation preconditions cleared:
 *     1. probe fallback fixed: probes/reddit-profile.ts:172-222 now uses
 *        /api/me.json with session cookies as fallback when unauthenticated
 *        /user/<x>/about.json returns 404 under anti-scraping throttle.
 *     2. dailyActionCap enforced in warmup-planner.ts (cap=3 means at
 *        most 3 grooming actions in any rolling 24h window per Reddit
 *        account). Soft block returns rate_limit + blockedUntil derived
 *        from the oldest in-window timestamp; never persists, never
 *        contaminates the platform-side cooldown row.
 *     3. 'reddit' restored to dev-warmup.ts VALID_PLATFORMS.
 *
 * Long-running stability across CDP sessions (IndexedDB / Service Worker
 * persistence) depends on Mosaiq Phase 11.5 `keepAlive: true` + sticky pod
 * routing. Without sticky pods every createSession lands on a fresh microVM
 * and the pod's --user-data-dir (where IndexedDB / Service Worker state
 * lives) is destroyed on close. Reddit auth cookies replay from LaunchAI's
 * storageState so `engage` / `post` / `comment` work today, but PWA / SW
 * state from new.reddit.com does not survive across cycles — a soft
 * anti-bot signal since real accounts accumulate weeks of SW state. The
 * full spec for what LaunchAI needs from Mosaiq is in
 * `docs/MOSAIQ-INTEGRATION-REQUESTS.md` Request 1; Mosaiq's own Phase 11.5
 * doc had not been drafted as of this revive.
 *
 * ---
 *
 * Reddit is unlike single-feed platforms because each subreddit has its own
 * rules, karma minima, posting frequency limits, and self-promo policy.
 * The recipes below force the agent to:
 *   1. Read the target sub's rules + sidebar BEFORE posting / commenting.
 *   2. Skip the action with a structured `subreddit_rules` block when the
 *      rules forbid it — the adapter persists this to a PER-SUBREDDIT
 *      cooldown so other subs remain available.
 *
 * See:
 *   - docs/PLATFORM_EXTENSIBILITY.md for the manifest model
 *   - SubredditState in src/lib/platforms/types.ts for the per-sub state slice
 */
import { z } from 'zod'
import type { PlatformManifest, PreActionGateVerdict } from '../manifest'
import { loadRedditProfileCached } from '../probes/reddit-profile'
import {
  fetchRedditEngageCandidates,
  formatCandidatesForPrompt,
} from '../probes/reddit-candidates'
import { buildEngageReplyGoal } from '../skills/engage-reply'
import { DEFAULT_COOLDOWN_HOURS } from './common'

// ────────────────────────────────────────────────────────────────────────────
// Pre-action gate thresholds
// ────────────────────────────────────────────────────────────────────────────
//
// Conservative defaults. Reddit doesn't publish exact thresholds; these are
// calibrated against the "fresh account, first post auto-removed" pattern
// most new accounts hit. Tighter bars = fewer wasted posts; looser bars =
// more auto-removes. We can tune once we have telemetry on gate outcomes.
//
// NOTE: these are ACCOUNT-LEVEL bars, not per-subreddit. A sub may require
// more karma than the account-level threshold; those blocks are caught by
// the in-agent preflight + per-sub cooldown path instead.

/** Minimum total karma (link + comment) before `post` is allowed. */
const MIN_KARMA_FOR_POST = 10
/** Minimum total karma before `comment` / `engage` / `reply` is allowed. */
const MIN_KARMA_FOR_COMMENT = 1
/** Minimum account age in days before ANY write action is allowed. */
const MIN_ACCOUNT_AGE_DAYS = 3
/**
 * How long to defer after a gate rejection. 24h is long enough for the
 * user to run warmup actions; shorter means the supervisor will keep
 * re-hitting the gate every few hours.
 */
const GATE_DEFER_HOURS = 24

// ────────────────────────────────────────────────────────────────────────────
// Payload schemas
// ────────────────────────────────────────────────────────────────────────────

/**
 * Subreddit name without the `r/` prefix. Reddit accepts letters, digits,
 * and underscore (3–21 chars typically; we allow up to 50 for niche subs
 * that pre-date the current naming rule).
 */
const SubredditName = z
  .string()
  .min(2)
  .max(50)
  .regex(/^[A-Za-z0-9_]+$/, 'subreddit must be the bare name without "r/"')

const PostPayload = z
  .object({
    subreddit: SubredditName,
    title: z.string().min(15).max(300),
    /** Self-post body. Markdown allowed. */
    body: z.string().min(50).max(40_000).optional(),
    /** Link-post URL. Mutually exclusive with body. */
    url: z.string().url().optional(),
    /** Some subs require a flair. */
    flair: z.string().min(1).max(60).optional(),
  })
  .refine(
    (v) => Boolean(v.body) !== Boolean(v.url),
    'post requires exactly one of body (self-post) or url (link post)',
  )

const CommentPayload = z.object({
  /** Direct link to the post or comment thread. */
  url: z.string().url(),
  body: z.string().min(5).max(10_000),
  /** Optional but strongly preferred — used for per-sub cooldown bookkeeping. */
  subreddit: SubredditName.optional(),
})

const UpvotePayload = z.object({
  urls: z.array(z.string().url()).min(1).max(10),
})

const FollowPayload = z
  .object({
    /** Subreddits to subscribe to. */
    subreddits: z.array(SubredditName).min(1).max(10).optional(),
    /** Reddit usernames to follow (no `u/` prefix). */
    usernames: z.array(z.string().min(2).max(60)).min(1).max(10).optional(),
  })
  .refine(
    (v) => Boolean(v.subreddits?.length || v.usernames?.length),
    'follow requires at least one of subreddits[] or usernames[]',
  )

/**
 * Engage = reply helpfully on someone else's Reddit post. This is the
 * karma-building action for warmup. The agent picks a target thread inside
 * one of the allowed subreddits and writes a short on-topic reply.
 *
 * The payload intentionally does NOT accept a thread URL — warmup is about
 * generic karma building, not engaging on a specific post. If a caller
 * wants a specific-thread reply, use the `comment` action with its own
 * body. That separation keeps `engage` audit-safe: it can only touch the
 * pre-approved subreddit allowlist the campaign supplies.
 */
const EngagePayload = z.object({
  /**
   * Allowed subreddits for this warmup pass. Keep this LIST short and
   * safe — see REDDIT_WARMUP_SAFE_SUBS below for defaults. Campaigns can
   * override with topic-specific subs once they have some karma built up.
   */
  subreddits: z.array(SubredditName).min(1).max(10),
  /** How many separate replies to leave this run. Default 1 for safety. */
  count: z.number().int().min(1).max(3).default(1),
  /** Optional topic phrase the reply should relate to. Purely advisory. */
  topic: z.string().min(3).max(200).optional(),
})

/**
 * Subreddits considered "warmup-safe" — high traffic, conversation-friendly,
 * lenient moderation, rarely ban new accounts over a single well-formed
 * comment. Used as the default allowlist in warmupRules when the campaign
 * context does not specify its own list.
 *
 * NEVER include: product-discussion subs (easy self-promo misfire),
 * politics, controversial topics, private / invite-only subs, subs with
 * posted "no new accounts" rules (r/AskHistorians etc).
 */
const REDDIT_WARMUP_SAFE_SUBS: readonly string[] = [
  'AskReddit',
  'NoStupidQuestions',
  'explainlikeimfive',
  'todayilearned',
  'mildlyinteresting',
  'LifeProTips',
  'YouShouldKnow',
]

/** Karma ceiling for warmup-triggered engage. Below this we keep engaging. */
const WARMUP_KARMA_TARGET = MIN_KARMA_FOR_POST

// ────────────────────────────────────────────────────────────────────────────
// System addendum — Reddit-specific etiquette baked into every agent run
// ────────────────────────────────────────────────────────────────────────────

const REDDIT_ADDENDUM = [
  'Reddit is a federation of subreddits with very different rules.',
  'Self-promotion is forbidden by default in most subs.',
  'Always read the target sub\'s posted rules + sidebar BEFORE writing.',
  'Default to value-first content; no marketing language; no link drops.',
  'When unsure, do not post. Call finish with success=false and the structured',
  'block reason ("subreddit_rules") + verbatim evidence so the system can learn.',
  '',
  'Page-routing notes:',
  '- For READS (rules, sidebars, post bodies, comments) prefer old.reddit.com.',
  '  It is plain HTML so `read_main_content` works reliably and there is no',
  '  SPA hydration race.',
  '- For WRITES (submitting posts, comments) use www.reddit.com — the new',
  '  reddit submit form is more reliable than the old.reddit one.',
  '- Sidebars (right rail on old.reddit, with rules/flair/announcements) are',
  '  not picked up by `read_main_content`; use `extract_text` with',
  '  selector=".side" if you specifically need sidebar content.',
].join('\n')

// ────────────────────────────────────────────────────────────────────────────
// Reddit voice — rules + few-shot examples of good vs bad replies
//
// LLM-drafted comments fail the same way every time: generic openers,
// hollow agreement, fake personal stories, hedging filler, em-dashes.
// Reddit users instantly smell it and downvote. Negative karma from a bad
// engage is strictly WORSE than not engaging — it moves the account
// further from the posting threshold.
//
// These rules are injected into the `engage` goal template. We keep them
// out of the general `comment` action because comment replies use a
// user-supplied body verbatim — the voice is the user's, not ours.
// ────────────────────────────────────────────────────────────────────────────

const REDDIT_VOICE_RULES = `
VOICE — write like a real redditor, not a chatbot.

Content principles:
  - EXACTLY ONE specific concrete thing per reply: a number, a year, a named
    tool, a brand, a lived observation, an analogy. If you cannot name a
    specific thing to add, do NOT reply — pick a different post or finish.
  - Address OP directly, not the audience. "you could try X" > "one could".
  - Add something the post did NOT say. Restating OP's question = downvote.

Length:
  - 40 to 200 characters total. Aim for 2 short sentences.
  - Over 200 chars on a new-account engage reads as essay-shilling; redraft.

Register:
  - Lowercase sentence starts are fine ("that's how it always was").
  - Fragments are fine ("depends on the humidity").
  - Contractions: "don't" not "do not"; "i've" not "I have"; "it's" not "it is".
  - No exclamation marks at sentence end. Period or nothing.
  - No em-dashes (—). Use a comma or two sentences.
  - No semicolons in casual replies.

FORBIDDEN openers (remove if your draft starts with any of these):
  "Great ", "Thanks ", "Love ", "Interesting ", "Wow", "This!", "This is",
  "As someone ", "As an ", "I think ", "IMO", "IMHO", "Honestly, ",
  "Actually, ", "To be fair", "In my experience"

FORBIDDEN phrases (remove if your draft contains ANY of these, anywhere):
  "worth noting", "keep in mind", "it depends", "many factors",
  "mileage may vary", "that said", "hope this helps", "just my two cents",
  "at the end of the day", "thanks for sharing", "great question",
  "great point", "good point", "I can relate", "same here"

FORBIDDEN shapes:
  - Agreement-only ("+1", "exactly", "this", "so true") with no content added.
  - A question back to OP (questions volley the burden; low-effort).
  - Advice OP did not ask for ("you should really try...").
  - Invented personal history ("When I worked at Google I saw..."). If you
    don't have direct experience, state a fact or analogy instead.

Few-shot examples. Copy the SHAPE and TERSENESS, not the literal content:

Example 1 — r/NoStupidQuestions
  Post:  "Why do we say 'break a leg' instead of 'good luck'?"
  BAD  → "Great question! 'Break a leg' comes from theater superstition that
          saying 'good luck' would jinx the show. Hope this helps!"
  GOOD → "theater superstition. saying 'good luck' was thought to jinx the
          show, so actors say the opposite. same reason sailors won't say
          'rabbit' on a boat."

Example 2 — r/AskReddit
  Post:  "What skill took you way longer than expected to learn?"
  BAD  → "Honestly, I've learned many skills and patience is key. It really
          depends on your learning style. Don't give up!"
  GOOD → "touch typing. hunt-and-peck for 15 years, took me 3 months of
          forcing myself to not look at the keys to get past 60wpm."

Example 3 — r/explainlikeimfive
  Post:  "ELI5 how does VPN encryption work?"
  BAD  → "Great question! VPNs use complex encryption algorithms to create
          a secure tunnel for your data. It's worth noting that..."
  GOOD → "imagine mailing a letter inside a locked box. only you and your
          friend have the key. anyone in between sees the box but can't
          read what's inside."

Example 4 — r/LifeProTips (on a tip about remembering names)
  Post:  "LPT: repeat a person's name 3 times in the first minute to remember it."
  BAD  → "This is so true! I totally agree. I will definitely try this."
  GOOD → "works even better if you use their name in a question back to
          them. forces you to rehearse it in a sentence, not just echo."

Before clicking Reply, run this SELF-REVIEW checklist against your draft.
If ANY answer is YES, redraft (up to 2 attempts); on third failure, skip
this post and pick another:

  1. Does it start with any FORBIDDEN opener?                      [Y/N]
  2. Does it contain any FORBIDDEN phrase?                         [Y/N]
  3. Does it have any em-dash, or a "!" at sentence end?           [Y/N]
  4. Is it over 200 characters?                                    [Y/N]
  5. Is it ONLY agreement/restating OP?                            [Y/N]
  6. Does it ask OP a question back?                               [Y/N]
  7. Does it invent a personal job or experience?                  [Y/N]
  8. If you removed it, would the thread lose any specific info?   [N = YES bad]
`

// ────────────────────────────────────────────────────────────────────────────
// Reusable goalTemplate fragment — sub-rules preflight checklist
// ────────────────────────────────────────────────────────────────────────────

const SUBREDDIT_PREFLIGHT = `
SUBREDDIT PREFLIGHT — you MUST do this before any write to a sub:

  1. Navigate to https://old.reddit.com/r/{{subreddit}}/about/rules then call
     \`read_main_content\` to get the rules text. (Use old.reddit.com because
     new reddit.com sometimes redirects /about/rules to /mod/{{subreddit}}/rules
     which is harder to parse.)
  2. Navigate to https://old.reddit.com/r/{{subreddit}}/ then read the
     sidebar with: extract_text selector=".side"
     The right sidebar holds posting requirements, flair list, sticky
     pointers, and "READ FIRST" announcements that aren't in /about/rules.
     (\`read_main_content\` skips sidebars by design, so you need the explicit
     selector here.)
  3. Decide: does the planned action violate any rule? Common deal-breakers:
       - "No self-promotion" or "Promotional content removed"
       - Karma threshold ("100 combined karma to post")
       - Account-age threshold ("Account must be 30 days old")
       - Required flair the user didn't provide
       - Recent-post frequency cap ("once per week")
  4. If ANY rule blocks the planned action, do NOT attempt the write. Call
     finish with success=false, output={ blocked_reason: 'subreddit_rules',
     evidence: '<verbatim rule text>', summary: '<one sentence>' }.
  5. If rules are unclear, err on the side of NOT posting (call finish with
     blocked_reason=manual_review and evidence describing the ambiguity).

Capture a 1–2 sentence rulesSummary describing what the sub allows / forbids
so the system can cache it for next time.`

// ────────────────────────────────────────────────────────────────────────────
// Manifest
// ────────────────────────────────────────────────────────────────────────────

export const redditManifest: PlatformManifest = {
  id: 'reddit',
  displayName: 'Reddit',
  baseUrl: 'https://www.reddit.com',
  loginUrl: 'https://www.reddit.com/login',

  audienceProfile: {
    summary:
      'Reddit audience varies enormously by subreddit. With targeted subs (r/Lawyers, r/sysadmin, r/privacy, r/smallbusiness, r/personalfinance, r/parenting, etc.) almost any non-enterprise audience can be reached. Mainstream subs skew young, English-speaking, tech-comfortable. Self-promo is universally punished — value-first only.',
    tags: [
      'varied-by-subreddit',
      'consumer',
      'professionals',
      'developers',
      'sysadmins',
      'lawyers',
      'gamers',
      'parents',
      'privacy-conscious',
      'small-business-owners',
      'hobbyists',
    ],
    notSuitableFor: ['enterprise-c-suite', 'pure-self-promo'],
  },

  loginProbe: {
    loggedInUrl: 'https://www.reddit.com/',
    loggedOutUrlMarkers: ['/login', '/account/login'],
    loggedInTextMarkers: ['Create Post', 'My profile', 'Home Feed'],
    loggedOutTextMarkers: ['Log In', 'Sign Up'],
  },

  capabilities: {
    canRead: true,
    canPost: true,
    canComment: true,
    canCollectMetrics: true,
    // Reddit's official API requires an OAuth app + per-account approval.
    // For solo founders we default to the browser path and add API later.
    executionMode: 'browser',
    requiresHumanFinalize: false,
    maxAutonomousRiskLevel: 2,
    dailyActionCap: 3,
  },

  defaultRiskByActionType: {
    crawl: 0,
    upvote: 1,
    follow: 1,
    comment: 2,
    post: 2,
    set_profile: 1,
    // engage is risk 2 (not 3 like IH): the Reddit engage recipe carries
    // stronger guardrails than a generic model-generated comment — a
    // closed subreddit allowlist, 1-reply-per-run cap, the REDDIT_VOICE_RULES
    // few-shot/blocklist block, and a self-review checklist. Risk 2 means
    // warmup can run it without per-action approval up to the daily cap.
    engage: 2,
  },

  systemAddendum: REDDIT_ADDENDUM,

  // ──────────────────────────────────────────────────────────────────────────
  // Action recipes
  // ──────────────────────────────────────────────────────────────────────────
  actions: {
    post: {
      payloadSchema: PostPayload,
      goalTemplate: `Submit a new Reddit post in r/{{subreddit}}.

CONTEXT:
  subreddit: {{subreddit}}
  title: "{{title}}"
  body: provided in CONTEXT.body (use verbatim if present)
  url:  provided in CONTEXT.url  (use verbatim if present, link post)
  flair: optional, provided in CONTEXT.flair

${SUBREDDIT_PREFLIGHT}

If the preflight passes:
  1. Navigate to https://www.reddit.com/r/{{subreddit}}/submit
  2. Choose "Post" (text) if CONTEXT.body is provided, or "Link" if CONTEXT.url
     is provided. Fill in title verbatim.
  3. If CONTEXT.flair is provided and the sub requires flair, pick the
     matching flair from the picker.
  4. Click Post / Submit. Wait for the redirect to /r/{{subreddit}}/comments/...
  5. Verify the post landed (URL contains /comments/, your title visible).
  6. Call finish with success=true and output={
       url: '<final permalink>',
       subreddit: '{{subreddit}}',
       rulesSummary: '<1-2 sentence summary of what the sub allows>'
     }`,
      startUrl: 'https://www.reddit.com/',
      maxSteps: 50,
      maxWallclockMs: 240_000,
      onSuccess: 'recordSubredditPost',
    },

    comment: {
      payloadSchema: CommentPayload,
      goalTemplate: `Post a reply on the Reddit thread at CONTEXT.url.

If CONTEXT.subreddit is provided, do the SUBREDDIT PREFLIGHT for that sub
first. (Comments are usually allowed even when posts aren't, but we still
check for "No new accounts commenting" / karma minima / etc.)

${SUBREDDIT_PREFLIGHT}

If the preflight passes:
  1. Navigate to CONTEXT.url.
  2. Find the top-level reply box (or click Reply on the specific parent
     comment if the URL points to a comment, not a post).
  3. Type CONTEXT.body verbatim. Do NOT add greetings, signatures, or links
     unless they are already part of CONTEXT.body.
  4. Click Reply / Comment. Wait until your reply appears on the page.
  5. Call finish with success=true and output={
       url: CONTEXT.url,
       subreddit: '{{subreddit}}',
       rulesSummary: '<1 sentence>'
     }`,
      startUrl: (p) => (p as z.infer<typeof CommentPayload>).url,
      maxSteps: 30,
      maxWallclockMs: 150_000,
      onSuccess: 'recordSubredditComment',
    },

    upvote: {
      payloadSchema: UpvotePayload,
      goalTemplate: `Upvote each Reddit URL in CONTEXT.urls.

For each URL:
  1. Navigate to it.
  2. If already upvoted (the up-arrow is filled / colored), skip.
  3. Click the up-arrow next to the post or comment. Verify the count
     incremented or the arrow changed state.
  4. Move to the next URL.

When done call finish with success=true and output={
  upvoted: ['<url>', ...],
  skipped: ['<url>', ...]
}.

Never upvote your own content.`,
      startUrl: (p) => (p as z.infer<typeof UpvotePayload>).urls[0]!,
      maxSteps: 35,
      maxWallclockMs: 180_000,
      onSuccess: 'recordUpvote',
    },

    follow: {
      payloadSchema: FollowPayload,
      goalTemplate: `Subscribe to subreddits and/or follow Reddit users per CONTEXT.

If CONTEXT.subreddits is provided, for each one:
  1. Navigate to https://www.reddit.com/r/<sub>/
  2. Click the Join / Subscribe button. Verify the button flipped to
     Joined / Leave / Unsubscribe.
  3. Skip if already joined.

If CONTEXT.usernames is provided, for each one:
  1. Navigate to https://www.reddit.com/user/<username>/
  2. Click Follow. Verify the button flipped to Following.
  3. Skip if already following.

When done call finish with success=true and output={
  joined: ['<sub>', ...],
  followed: ['<username>', ...],
  skipped: ['<sub-or-username>', ...]
}.`,
      startUrl: 'https://www.reddit.com/',
      maxSteps: 35,
      maxWallclockMs: 180_000,
      onSuccess: 'recordFollow',
    },

    engage: {
      payloadSchema: EngagePayload,
      // The engage action has the tightest guardrails in this manifest —
      // it's the one that can most easily go wrong (spammy comment →
      // downvotes → negative karma; off-topic → report → ban).
      //
      // Structure of the template (in order):
      //   1. Task definition + the PRE-RESOLVED candidate shortlist
      //   2. HARD PROCESS CONSTRAINTS (non-negotiable)
      //   3. VOICE rules + few-shot + self-review (how the comment sounds)
      //   4. Workflow (step-by-step tool calls, now short — candidates
      //      are pre-resolved so the agent skips browse/search)
      //   5. Finish contract
      //
      // Why async + server-side candidate pre-resolution:
      //   The previous workflow asked the agent to browse /r/<sub>/hot/
      //   and pick a post in-browser. `read_main_content` doesn't extract
      //   usefully from Reddit listing pages, so the agent burned 20+
      //   steps cycling extraction tools before giving up. We now fetch
      //   `/r/<sub>/hot.json` server-side (public API, no auth needed),
      //   filter out stickied/locked/NSFW/megathread/too-old/too-quiet
      //   posts, and hand the agent 5 concrete permalinks. Agent work
      //   drops from ~40 steps to ~12.
      goalTemplate: async (payload) => {
        const p = EngagePayload.parse(payload)
        const candidates = await fetchRedditEngageCandidates(p.subreddits, {
          limit: 5,
        })
        const candidatesBlock = formatCandidatesForPrompt(candidates)

        return buildEngageReplyGoal({
          platformName: "Reddit",
          reputationNoun: 'comment karma',
          contextLines: [
            `target subreddits (allowlist): ${p.subreddits.join(', ')}`,
            `topic (advisory):              ${p.topic ?? '(none — pick any candidate)'}`,
            `replies to post this run:      ${p.count}`,
          ],
          candidatesBlock,
          additionalHardConstraints: [
            'Do not reply in subreddits not on the allowlist.',
          ],
          voiceRules: REDDIT_VOICE_RULES,
          selectors: {
            replyTextarea: "textarea[name='text']",
            // On old.reddit the submit is LITERALLY labelled "save" (posts
            // the comment, does NOT save a draft). role=button[name="Comment"]
            // is the new-reddit equivalent — the agent may land on either
            // surface depending on which path it came from.
            submitButton: 'role=button[name="save"]',
            knownWrongSubmitSelectors: [
              "button[name='save']",
              'button[submit]',
              "button[type='submit']",
            ],
          },
          // On old.reddit, `edit` and `delete` links only render adjacent to
          // YOUR OWN comments — strong, specific proof the reply landed.
          positiveMarkers: ['a "edit"', 'a "delete"'],
          replyPermalinkShape:
            'a "permalink" → https://old.reddit.com/r/<sub>/comments/<post>/<slug>/<comment>/',
          negativeBannerKeywords: [
            'doing that too much',
            'please solve this captcha',
            'held for review',
            'being reviewed',
          ],
        })
      },
      startUrl: 'https://old.reddit.com/',
      // With candidates pre-resolved, the workflow is ~7 tool calls +
      // some reasoning steps. 25 is plenty; 30 for safety.
      maxSteps: 30,
      maxWallclockMs: 180_000,
      onSuccess: 'recordEngagement',
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Block / cooldown detection
  //
  // Patterns are conservative — the agent's structured blocked_reason is
  // the primary signal; these are fallbacks for unstructured failure paths.
  // ──────────────────────────────────────────────────────────────────────────
  blockedHints: [
    {
      pattern: /verify your email|please confirm.*email|email.*not.*verified/i,
      reason: 'verify_email',
      description: 'Reddit requires email verification.',
    },
    {
      pattern: /you are doing that too much|try again in (\d+) (minute|hour|second)/i,
      reason: 'rate_limit',
      retryHours: 1,
      description: 'Reddit anti-spam rate limit.',
    },
    {
      pattern: /karma|requires.*karma|not enough karma/i,
      reason: 'karma_threshold',
      description: 'Subreddit or sitewide karma minimum not met.',
    },
    {
      pattern: /account is too new|account must be at least \d+ days?/i,
      reason: 'new_account',
      description: 'New-account posting block.',
    },
    {
      pattern: /removed by automod|filtered.*moderat|pending.*moderation|under review/i,
      reason: 'manual_review',
      description: 'AutoModerator or human moderator filtered the submission.',
    },
    {
      pattern: /no self.?promotion|promotional content|self-?promo.*not allowed|read.*sidebar/i,
      reason: 'subreddit_rules',
      description: 'Subreddit forbids self-promotion or similar.',
    },
    {
      pattern: /captcha|verify you are human|cloudflare/i,
      reason: 'captcha',
      description: 'Anti-bot challenge.',
    },
  ],

  defaultCooldownHoursByReason: DEFAULT_COOLDOWN_HOURS,

  // ──────────────────────────────────────────────────────────────────────────
  // Warm-up plan — karma-driven (Reddit's actual gate), not profile-driven
  //
  // Reddit karma builds via COMMENT replies. Upvoting, following, or setting
  // a bio has near-zero effect on the numbers Reddit uses to decide whether
  // your posts are visible. We therefore only have ONE warmup rule right
  // now: engage (reply helpfully on someone else's post). We can add
  // set_profile / upvote later as optional polish — they're not the lever.
  //
  // The rule fires whenever metrics.karma is below the post threshold and
  // produces a single engage with the safe-subs allowlist. The planner's
  // caller runs this once, the adapter records a grooming timestamp, the
  // probe re-reads karma (next call is cached for 6h), and the next plan
  // either fires again or moves on if we crossed the threshold.
  // ──────────────────────────────────────────────────────────────────────────
  warmupRules: [
    {
      id: 'reddit-warmup-engage',
      when: (s) => (s.metrics?.karma ?? 0) < WARMUP_KARMA_TARGET,
      reason: (s) =>
        `Karma ${s.metrics?.karma ?? 0}/${WARMUP_KARMA_TARGET} — helpful replies on others' posts are the fastest legal way to build comment karma.`,
      produce: (_s, ctx) => ({
        campaignId: ctx.campaignId,
        type: 'engage',
        // Must stay <= manifest.capabilities.maxAutonomousRiskLevel or the
        // validator will demand per-action approval and warmup cannot
        // self-serve. See the comment on engage in defaultRiskByActionType
        // for why 2 is justified for THIS engage recipe specifically.
        riskLevel: 2,
        payload: {
          subreddits: [...REDDIT_WARMUP_SAFE_SUBS],
          count: 1,
        },
      }),
    },
  ],

  // ──────────────────────────────────────────────────────────────────────────
  // Pre-action gate — refuse mutating actions on accounts that will fail
  //
  // Reddit silently shadow-removes posts/comments from very-fresh accounts
  // (0 karma, <a few days old). The agent CANNOT detect this — the form
  // accepts the post, the redirect happens, the URL looks fine. The post
  // is just invisible to everyone but the author. Burning $0.01 + 60s of
  // browser time + a real spam-filter strike to discover this is bad.
  //
  // This gate runs BEFORE the browser launches. It probes /user/<me>/about.json
  // (free, <1s, public) and refuses if the account is below thresholds.
  // The cooldown returned tells the supervisor "don't try this class of
  // action for 24h — run warmup first".
  //
  // Read-only actions (crawl) skip the gate (handled by the adapter).
  // ──────────────────────────────────────────────────────────────────────────
  preActionGate: async (action, _state): Promise<PreActionGateVerdict> => {
    const probe = await loadRedditProfileCached(action.userId)

    // Probe failed — possible causes, in descending likelihood:
    //   1. Session cookies expired (user must reconnect — `verify_email`
    //      is the wrong label; we don't have a dedicated 'stale_session'
    //      reason so 'manual_review' is the least-bad fit).
    //   2. Reddit rate-limited our about.json fetch.
    //   3. User's account is suspended / shadowbanned (about.json 404s).
    //
    // The evidence string covers the fallback suggestion for users who
    // never set --label AND whose cookie resolution also failed.
    if (!probe) {
      return {
        deferred: true,
        reason: 'manual_review',
        evidence:
          'Could not probe Reddit account. The stored session may have expired, ' +
          'the account may be suspended, or Reddit rate-limited the probe. ' +
          'Try: pnpm connect:account reddit --label <your-reddit-username> to refresh.',
        cooldownUntil: new Date(Date.now() + GATE_DEFER_HOURS * 3600_000),
      }
    }

    const { profile } = probe
    const ageOk = profile.accountAgeDays >= MIN_ACCOUNT_AGE_DAYS

    // Age is the universal floor — Reddit's anti-spam signal that doesn't
    // depend on action class. Account too young → no writes at all.
    if (!ageOk) {
      return {
        deferred: true,
        reason: 'new_account',
        evidence:
          `Account @${profile.username} is ${profile.accountAgeDays}d old; ` +
          `Reddit silently filters writes from accounts under ${MIN_ACCOUNT_AGE_DAYS}d. ` +
          `Wait, then run warmup actions to build trust before posting.`,
        cooldownUntil: new Date(Date.now() + GATE_DEFER_HOURS * 3600_000),
      }
    }

    // Karma threshold depends on action class:
    //   - post:         MIN_KARMA_FOR_POST (defense against shadow-remove)
    //   - comment/reply: MIN_KARMA_FOR_COMMENT (lighter but still non-zero —
    //                    named-sub comments still get auto-filtered at 0)
    //   - engage:        0 (bootstrap — engage IS the karma-building warmup
    //                    action, so gating it on karma is catch-22)
    //   - everything else (upvote, follow, set_profile): 0
    const minKarma =
      action.type === 'post'
        ? MIN_KARMA_FOR_POST
        : action.type === 'comment' || action.type === 'reply'
          ? MIN_KARMA_FOR_COMMENT
          : 0

    if (profile.totalKarma < minKarma) {
      return {
        deferred: true,
        reason: 'karma_threshold',
        evidence:
          `Account @${profile.username} has ${profile.totalKarma} karma ` +
          `(link ${profile.linkKarma} + comment ${profile.commentKarma}); ` +
          `${action.type} requires ≥${minKarma}. ` +
          `Run warmup actions (upvote, engage on others' posts) to build karma.`,
        cooldownUntil: new Date(Date.now() + GATE_DEFER_HOURS * 3600_000),
      }
    }

    // Account meets the bar — let the action through.
    return { deferred: false }
  },
}
