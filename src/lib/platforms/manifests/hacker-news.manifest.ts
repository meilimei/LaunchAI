/**
 * Hacker News — declarative platform manifest.
 *
 * HN has no third-party write API — every action is browser-driven.
 * The community is unforgiving of self-promo; defaults are conservative.
 *
 * Architecture mirrors the Reddit manifest:
 *   - `engage` action delegates its prompt to the shared engage-reply
 *     skill (src/lib/platforms/skills/engage-reply.ts), supplying only
 *     the platform-specific slots (voice, selectors, markers, URL shape).
 *   - Candidates are pre-resolved via Algolia HN search so the agent
 *     receives a concrete shortlist of item permalinks and skips browsing.
 *   - No preActionGate yet — HN is permissive about commenting from new
 *     accounts (there is no karma floor for comments). Add a gate once
 *     we see real shadow-ban patterns in telemetry.
 */
import { z } from 'zod'
import type { PlatformManifest } from '../manifest'
import {
  fetchHNEngageCandidates,
  formatHNCandidatesForPrompt,
} from '../probes/hn-candidates'
import { buildEngageReplyGoal } from '../skills/engage-reply'
import { DEFAULT_COOLDOWN_HOURS } from './common'

// ────────────────────────────────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────────────────────────────────

/**
 * How many engage replies should the warmup loop accumulate before the
 * account is considered "warmed" on HN. HN's trust signal is account age
 * + a handful of substantive comments; 5 is a reasonable floor.
 */
const HN_WARMUP_ENGAGE_TARGET = 5

// ────────────────────────────────────────────────────────────────────────────
// Engage payload
// ────────────────────────────────────────────────────────────────────────────

/**
 * Payload for HN `engage`. Defaults favor Show HN / Ask HN (discussion-
 * seeking threads where a thoughtful reply is welcome and safe — replying
 * on a political Front Page story is a great way to get flagged).
 */
const HNEngagePayload = z.object({
  /**
   * Which HN story classes are eligible. Narrower = safer:
   *   'show' → Show HN (invites feedback)
   *   'ask'  → Ask HN (wants specific answers)
   *   'story' → any front-page story (broadest, highest variance)
   */
  storyTypes: z
    .array(z.enum(['show', 'ask', 'story']))
    .nonempty()
    .default(['show', 'ask']),
  /**
   * Optional case-insensitive substrings that must appear in the title or
   * body. Use sparingly — narrow keyword filters drop 80%+ of hits.
   */
  topicKeywords: z.array(z.string()).optional(),
  count: z.number().int().min(1).max(3).default(1),
})

// ────────────────────────────────────────────────────────────────────────────
// System addendum — tone floor for every HN browser task
// ────────────────────────────────────────────────────────────────────────────

const HN_ADDENDUM = [
  'Hacker News rewards substance and harshly punishes self-promotion.',
  'Show HN must be your own work, technical, and free to try. Comments',
  'should be precise, technical, and never thank-you noise.',
].join(' ')

// ────────────────────────────────────────────────────────────────────────────
// HN voice — rules + few-shot examples
//
// HN fails DIFFERENTLY from Reddit. The anti-patterns are marketing
// adjectives, empty enthusiasm, un-grounded claims, and bike-shedding.
// The positive pattern is specific technical detail — benchmarks, version
// numbers, lived operational experience, or an honest tradeoff.
//
// Length and register are also different: HN comments run 2-4 sentences
// of proper prose, not fragments, and technical jargon is expected.
// ────────────────────────────────────────────────────────────────────────────

const HN_VOICE_RULES = `
VOICE — write like an HN commenter, not a press release.

Content principles:
  - EXACTLY ONE substantive technical contribution per reply: a benchmark
    number, a version, a specific gotcha you hit in production, a concrete
    tradeoff, a protocol-level detail, or a named alternative with ONE
    reason it differs. If you cannot name something specific, do NOT reply.
  - Address the OP or the technical claim, not "the audience".
  - Add something the post did NOT say. Restating the title = downvote.
  - Honest about uncertainty: "I think" / "IIRC" / "haven't measured" is
    fine when accurate. Overclaiming is punished hard.

Length:
  - 100 to 500 characters typical. Aim for 2-3 sentences of real prose,
    not fragments. Over 800 chars risks looking like a blog post, redraft.

Register:
  - Proper sentence casing. Periods. Full words — "because" not "bc".
  - Contractions like "I've" / "don't" / "it's" are fine.
  - Em-dashes and semicolons are acceptable (unlike Reddit). Use them
    when they clarify, not as decoration.
  - Technical jargon is expected when accurate — "p99", "cold start",
    "SSRF", "CRDT", "WAL". Do NOT define well-known terms.

FORBIDDEN openers (remove if your draft starts with any of these):
  "Great ", "Awesome ", "Love ", "Wow", "This is amazing",
  "This is really cool", "I just want to say", "As someone ",
  "As an engineer ", "Impressive work", "Congrats "

FORBIDDEN phrases (marketing / puffery / empty enthusiasm):
  "game-changer", "game-changing", "disruptive", "revolutionary",
  "next-level", "cutting-edge", "at the end of the day",
  "it's a no-brainer", "really excited", "super excited", "huge fan",
  "best in class", "scales infinitely", "enterprise-grade"

FORBIDDEN shapes:
  - Pure agreement with no technical content ("+1", "this", "exactly").
  - Compliment without substance ("great project!").
  - Asking a question the OP already answered in the body.
  - Advice the OP did not ask for ("you should rewrite it in Rust").
  - Invented credentials ("I built the same thing at Google"). If you
    don't have direct experience, reason from first principles instead.
  - Whataboutism / off-topic derails ("but what about X").

Few-shot examples. Copy the SHAPE and TERSENESS, not the literal content:

Example 1 — Show HN: a rate-limiting library
  BAD  → "This is really cool! Rate limiting is such an important topic.
          Great job on this!"
  GOOD → "Token bucket + sliding window is a reasonable default, but at
          high QPS the sliding-window check is the bottleneck because
          every request has to re-aggregate a time range. If you haven't
          already, benchmark against fixed-window-counters for hot paths."

Example 2 — Ask HN: How do you debug memory leaks in Node?
  BAD  → "Great question! I use the Chrome DevTools profiler and it
          works great. Good luck!"
  GOOD → "heap snapshots via --inspect then diff two snapshots 30s
          apart. the retained objects column tells you what's growing.
          clinic.js wraps this with a nicer UX but the raw devtools
          flow is what you want when the leak is in native addons."

Example 3 — a post about switching from Postgres to SQLite
  BAD  → "I've been saying this for years! Postgres is overkill for most
          startups. Great to see others catching on."
  GOOD → "works surprisingly well up to ~10 writers. the gotcha is WAL
          mode + concurrent long transactions: a reader holding the
          snapshot blocks checkpoint and your WAL grows unbounded. we
          caught it at 6GB."

Before clicking Reply, run this SELF-REVIEW checklist against your draft.
If ANY answer is YES, redraft (up to 2 attempts); on third failure, skip
this post and pick another:

  1. Does it start with any FORBIDDEN opener?                      [Y/N]
  2. Does it contain any FORBIDDEN marketing phrase?               [Y/N]
  3. Is it only agreement / compliment with no technical content?  [Y/N]
  4. Does it invent credentials or a specific employer?            [Y/N]
  5. Is it over 800 characters?                                    [Y/N]
  6. Does it repeat a claim OP already made in the body/title?     [Y/N]
  7. If you removed it, would the thread lose any concrete info?   [N = YES bad]
`

// ────────────────────────────────────────────────────────────────────────────
// Manifest
// ────────────────────────────────────────────────────────────────────────────

export const hackerNewsManifest: PlatformManifest = {
  id: 'hacker_news',
  displayName: 'Hacker News',
  baseUrl: 'https://news.ycombinator.com',
  loginUrl: 'https://news.ycombinator.com/login',

  audienceProfile: {
    summary:
      'Software engineers, infrastructure / security folks, hackers, deep-tech researchers, technical founders and CTOs. Highly skeptical of marketing language. Best for genuinely technical content; cruel to thin self-promo. Audience does not include non-technical professional buyers.',
    tags: [
      'software-engineers',
      'infrastructure',
      'security',
      'researchers',
      'hackers',
      'technical-founders',
      'ctos',
      'open-source',
      'deep-tech',
    ],
    notSuitableFor: [
      'lawyers',
      'admin-staff',
      'non-technical-buyers',
      'consumer-mass-market',
      'enterprise-procurement',
      'self-promo',
    ],
  },

  loginProbe: {
    loggedInUrl: 'https://news.ycombinator.com/',
    loggedOutUrlMarkers: ['/login'],
    loggedInTextMarkers: ['logout'],
  },

  capabilities: {
    canRead: true,
    canPost: true,
    canComment: true,
    canCollectMetrics: true,
    executionMode: 'browser',
    requiresHumanFinalize: false,
    maxAutonomousRiskLevel: 2,
    // One action per day is the right conservative default on HN — the
    // community notices comment-spam patterns. Warmup runs loop over
    // multiple days until engagementsCompleted crosses the target.
    dailyActionCap: 1,
  },

  // engage runs at risk 2 for the same reason Reddit engage does — it's
  // a public mutation with guardrails strong enough to self-serve.
  defaultRiskByActionType: {
    engage: 2,
  },
  systemAddendum: HN_ADDENDUM,

  actions: {
    engage: {
      payloadSchema: HNEngagePayload,
      // Agent work is small: candidates are pre-resolved, the workflow
      // is the standard 6-step shape baked into the engage-reply skill.
      goalTemplate: async (payload) => {
        const p = HNEngagePayload.parse(payload)
        const candidates = await fetchHNEngageCandidates(p.storyTypes, {
          limit: 5,
          topicKeywords: p.topicKeywords,
        })
        const candidatesBlock = formatHNCandidatesForPrompt(candidates)

        return buildEngageReplyGoal({
          platformName: 'Hacker News',
          reputationNoun: 'HN karma',
          contextLines: [
            `story classes: ${p.storyTypes.join(', ')}`,
            `topic keywords (advisory): ${p.topicKeywords?.join(', ') ?? '(none)'}`,
            `replies to post this run: ${p.count}`,
          ],
          candidatesBlock,
          additionalHardConstraints: [
            'Do not reply to flagged or [dead] items — if describe_page shows [flagged] / [dead] on the story, pick another candidate.',
            'No second top-level comment on the same story. One reply, then finish.',
          ],
          voiceRules: HN_VOICE_RULES,
          selectors: {
            // HN's comment form on a story page is a bare <textarea name="text">.
            replyTextarea: "textarea[name='text']",
            // The submit button is an <input type="submit" value="add comment">.
            // Playwright's role-based locator treats submit inputs as buttons
            // with the `value` as the accessible name.
            submitButton: 'role=button[name="add comment"]',
            // `input[submit]` is in here because describe_page renders a
            // `<input type="submit" value="X">` element as `input[submit] "X"`.
            // Agents naively treat that prefix as a CSS query and the click
            // silently times out (it's valid CSS but matches an attribute
            // named `submit`, which no element has). Verified: 2026-05-01
            // run wasted 2 clicks before the agent fell back to the
            // role-based selector.
            knownWrongSubmitSelectors: [
              'input[submit]',
              "button[type='submit']",
              'button[submit]',
              "input[name='comment']",
            ],
          },
          // Verified on a live HN comment: `a "edit"` and `a "delete"` render
          // adjacent to YOUR OWN comments for ~2 hours after posting and are
          // the strongest local proof of success. Originally we listed
          // `a "unvote"` too, but on HN that link only appears on comments
          // you UPVOTED, not on your own — removed to avoid sending the
          // agent looking for a marker that will never show up.
          positiveMarkers: ['a "edit"', 'a "delete"'],
          // After submit, HN redirects back to the story page with your
          // comment appended. The comment's timestamp link is a permalink
          // to item?id=<new_comment_id>, where <new_comment_id> is a
          // DIFFERENT integer from the story id (typically higher).
          replyPermalinkShape:
            'a "<N minutes ago>" → https://news.ycombinator.com/item?id=<new_comment_id>',
          negativeBannerKeywords: [
            "you're submitting too fast",
            'please slow down',
            'unknown or expired link',
            'that link has expired',
          ],
        })
      },
      startUrl: 'https://news.ycombinator.com/',
      maxSteps: 30,
      maxWallclockMs: 180_000,
      onSuccess: 'recordEngagement',
    },
  },

  // Structured blocked_reason from the agent is primary; these regex
  // hints catch the unstructured failure path (agent's free-text summary
  // contained a phrase we can map to a cooldown reason).
  blockedHints: [
    {
      pattern: /submitting too fast|please slow down/i,
      reason: 'rate_limit',
      description: "HN's literal phrasing for the rate-limit banner served after rapid submits.",
    },
    {
      pattern: /unknown or expired link|link has expired/i,
      // Session / FNID mismatch. Safe to retry after a short pause —
      // usually a cookie refresh fixes it. manual_review is heavier than
      // needed but it's the only reason we have that signals "human
      // should look". When a dedicated 'stale_session' is added, switch.
      reason: 'manual_review',
      description: 'HN form token expired — the session likely needs a refresh.',
    },
  ],
  defaultCooldownHoursByReason: DEFAULT_COOLDOWN_HOURS,

  // ──────────────────────────────────────────────────────────────────────────
  // Warmup plan
  //
  // HN doesn't publish a karma threshold for commenting — the gate is
  // implicit (new accounts get less default weight, some subs of the
  // community flag liberally). We measure warmup progress by count of
  // successful engagements the supervisor has recorded, targeting
  // HN_WARMUP_ENGAGE_TARGET before declaring the account posting-ready.
  //
  // One engage per planner tick, looped across days (dailyActionCap=1).
  // ──────────────────────────────────────────────────────────────────────────
  warmupRules: [
    {
      id: 'hn-warmup-engage',
      when: (s) =>
        (s.warmup?.engagementsCompleted ?? 0) < HN_WARMUP_ENGAGE_TARGET,
      reason: (s) =>
        `HN engagements ${s.warmup?.engagementsCompleted ?? 0}/${HN_WARMUP_ENGAGE_TARGET} — substantive replies on Show/Ask HN build account history before a Show HN launch.`,
      produce: (_s, ctx) => ({
        campaignId: ctx.campaignId,
        type: 'engage',
        riskLevel: 2,
        payload: {
          storyTypes: ['show', 'ask'],
          count: 1,
        },
      }),
    },
  ],
}
