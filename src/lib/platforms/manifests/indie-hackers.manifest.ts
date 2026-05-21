/**
 * Indie Hackers — declarative platform manifest.
 *
 * Source of truth for the IH integration. Consumed at runtime by
 * `ManifestBrowserAdapter` via `manifests/index.ts`. There is no
 * separate `IndieHackersAdapter` class — adding new actions or tuning
 * prompts means editing this file, not writing TypeScript logic.
 *
 * See docs/PLATFORM_EXTENSIBILITY.md for the layered architecture.
 */
import { z } from 'zod'
import type { PlatformManifest } from '../manifest'
import { DEFAULT_COOLDOWN_HOURS } from './common'

// ────────────────────────────────────────────────────────────────────────────
// Payload schemas — colocated with the manifest that consumes them.
// ────────────────────────────────────────────────────────────────────────────

const PostPayload = z.object({
  title: z.string().min(15).max(120),
  body: z.string().min(120).max(8000),
  group: z.string().min(2).max(60).optional(),
})

const CommentPayload = z.object({
  url: z.string().url(),
  body: z.string().min(10).max(4000),
})

const SetProfilePayload = z
  .object({
    avatar: z.string().url().optional(),
    bio: z.string().min(20).max(500).optional(),
    displayName: z.string().min(2).max(60).optional(),
    website: z.string().url().optional(),
  })
  .refine(
    (v) => Boolean(v.avatar || v.bio || v.displayName || v.website),
    'set_profile requires at least one of avatar / bio / displayName / website',
  )

const UpvotePayload = z
  .object({
    urls: z.array(z.string().url()).min(1).max(10).optional(),
    topic: z.string().min(3).max(120).optional(),
    count: z.number().int().min(1).max(5).optional(),
  })
  .refine(
    (v) => Boolean(v.urls?.length || v.topic),
    'upvote requires either urls[] or topic+count',
  )

const FollowPayload = z
  .object({
    usernames: z.array(z.string()).min(1).max(10).optional(),
    topic: z.string().min(3).max(120).optional(),
    count: z.number().int().min(1).max(5).optional(),
  })
  .refine(
    (v) => Boolean(v.usernames?.length || v.topic),
    'follow requires either usernames[] or topic+count',
  )

// Tunables — adjusted as we learn IH's actual gating thresholds.
const MIN_FOLLOWS = 10
const MIN_UPVOTES = 15
const MIN_ENGAGEMENTS = 5

export const indieHackersManifest: PlatformManifest = {
  id: 'indie_hackers',
  displayName: 'Indie Hackers',
  baseUrl: 'https://www.indiehackers.com',
  loginUrl: 'https://www.indiehackers.com/login',

  audienceProfile: {
    summary:
      'Bootstrapped solo founders and small teams building B2B SaaS, dev tools, and indie products. Tech-literate; values transparency, MRR milestones, and "build in public" stories.',
    tags: [
      'founders',
      'bootstrappers',
      'indie-makers',
      'b2b-saas',
      'devtools',
      'developers',
      'tech',
      'startups',
      'solopreneurs',
    ],
    notSuitableFor: [
      'enterprise-procurement',
      'non-technical-buyers',
      'consumer-mass-market',
      'regulated-professionals',
    ],
  },

  loginProbe: {
    loggedInUrl: 'https://www.indiehackers.com/dashboard',
    loggedOutUrlMarkers: ['/login', '/signin', '/sign-in'],
    loggedInTextMarkers: [
      'New Post',
      'Following',
      'Notifications',
      'My Profile',
      'Sign out',
      'Log out',
      'Your dashboard',
    ],
    loggedOutTextMarkers: [
      'Sign in to Indie Hackers',
      'Sign up for Indie Hackers',
      'Get started',
      'Welcome to Indie Hackers',
    ],
  },

  capabilities: {
    canRead: true,
    canPost: true,
    canComment: true,
    canCollectMetrics: false,
    executionMode: 'browser',
    requiresHumanFinalize: false,
    maxAutonomousRiskLevel: 2,
    dailyActionCap: 4,
  },

  defaultRiskByActionType: {
    crawl: 0,
    set_profile: 1,
    upvote: 2,
    follow: 2,
    comment: 2,
    post: 2,
    engage: 3,
  },

  systemAddendum: `Indie Hackers is a community of bootstrapped founders. Tone is first-person, concrete, and humble. Avoid marketing language. Prefer numbers (users, revenue, days) over adjectives. Engage with replies, never delete or edit posts unless the goal explicitly says so.`,

  // ────────────────────────────────────────────────────────────────────────
  // Action recipes
  // ──────────────────────────────────────────────────────────────────────────
  actions: {
    post: {
      payloadSchema: PostPayload,
      goalTemplate: `Submit a new Indie Hackers discussion post.
Title and body are provided in CONTEXT. Use them verbatim — do not rewrite.
If CONTEXT.group is provided, target that group; if you cannot find it, post to the default front page.
Confirm the post landed by reaching its detail page (URL contains /post/), then call finish with success=true and output={ url: <final-url> }.`,
      startUrl: 'https://www.indiehackers.com/',
      maxSteps: 40,
      maxWallclockMs: 180_000,
      onSuccess: 'none',
    },

    comment: {
      payloadSchema: CommentPayload,
      goalTemplate: `Post a reply to the Indie Hackers discussion at the URL in CONTEXT.url.
Reply text is in CONTEXT.body — use verbatim.
After submitting, verify the reply appears below your other comments, then call finish with success=true and output={ url: CONTEXT.url }.`,
      startUrl: (p) => (p as z.infer<typeof CommentPayload>).url,
      maxSteps: 25,
      maxWallclockMs: 120_000,
      onSuccess: 'none',
    },

    set_profile: {
      payloadSchema: SetProfilePayload,
      goalTemplate: `Update the logged-in user's Indie Hackers profile.

The profile editor lives at /account. On Indie Hackers this page is titled
"Create an Indie Hackers Profile" for accounts that have not finished
onboarding — that IS the form to fill, not an error page. The form may
require scrolling to reach all fields. Common labels: "Bio", "Profile
Picture" / "Avatar", "Website" / "URL", "Display name" / "Name".

Workflow:
  1. Always start with describe_page so you see the actual fields, names,
     and selectors.
  2. If interactive elements are empty, scroll the page (press End or
     PageDown) and describe_page again — the form may be below the fold.
  3. Apply only the fields present in CONTEXT. Leave other fields alone;
     never overwrite an existing value with an empty one.
  4. For text fields use the type tool with the visible label as the
     selector, e.g. role=textbox[name="Bio"]. For file uploads (avatar)
     fall back to input[type="file"].
  5. Click the Save / Update button and verify the change persisted by
     reloading or revisiting the page.
  6. Call finish with success=true and output={ updated: ['<field>', ...] }
     where <field> is one of: avatar, bio, displayName, website.

If the platform refuses (verify_email, captcha, manual review, etc.) follow
the BLOCK DETECTION rules below — do not retry indefinitely.`,
      startUrl: 'https://www.indiehackers.com/account',
      maxSteps: 40,
      maxWallclockMs: 180_000,
      onSuccess: 'recordProfileFields',
    },

    upvote: {
      payloadSchema: UpvotePayload,
      goalTemplate: `Upvote Indie Hackers posts per CONTEXT.
If CONTEXT.urls is provided: navigate to each URL, click upvote, verify it took, skip already-upvoted ones.
Otherwise: find CONTEXT.count posts (default 3) about CONTEXT.topic by browsing the front page and Groups, then upvote each.
Do not upvote your own posts.
When done, call finish with success=true and output={ upvoted: ['<url>', ...], skipped: ['<url>', ...] }.`,
      startUrl: (p) =>
        (p as z.infer<typeof UpvotePayload>).urls?.[0] ?? 'https://www.indiehackers.com/',
      maxSteps: 35,
      maxWallclockMs: 180_000,
      onSuccess: 'recordUpvote',
    },

    follow: {
      payloadSchema: FollowPayload,
      goalTemplate: `Follow Indie Hackers users per CONTEXT.
If CONTEXT.usernames is provided: navigate to /<username>, click Follow, verify the button flipped to Following, skip already-followed.
Otherwise: find CONTEXT.count users (default 3) about CONTEXT.topic by browsing /products and /groups, follow each.
Never follow your own account. Pick people who are genuinely on-topic — no follow-trains.
When done, call finish with success=true and output={ followed: ['<username>', ...], skipped: ['<username>', ...] }.`,
      startUrl: 'https://www.indiehackers.com/',
      maxSteps: 35,
      maxWallclockMs: 180_000,
      onSuccess: 'recordFollow',
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Block / cooldown detection
  // ──────────────────────────────────────────────────────────────────────────
  blockedHints: [
    {
      pattern: /verify your email|confirm your email/i,
      reason: 'verify_email',
      description: 'IH requires email verification before posting.',
    },
    {
      pattern: /need (more )?karma|not enough karma|reputation/i,
      reason: 'karma_threshold',
      description: 'IH karma threshold not met for this action.',
    },
    {
      pattern: /too many|slow down|wait a few minutes|rate limit/i,
      reason: 'rate_limit',
      retryHours: 1,
      description: 'IH soft rate limit.',
    },
    {
      pattern: /under review|pending review|moderation/i,
      reason: 'manual_review',
      description: 'Action queued for moderator review.',
    },
    {
      pattern: /captcha|verify you are human|cloudflare/i,
      reason: 'captcha',
      description: 'Anti-bot challenge.',
    },
    {
      pattern: /new account|account is too new|wait \d+ ?h/i,
      reason: 'new_account',
      description: 'New-account posting block.',
    },
  ],

  defaultCooldownHoursByReason: DEFAULT_COOLDOWN_HOURS,

  // ──────────────────────────────────────────────────────────────────────────
  // Warm-up plan — ordered rules consumed by warmup-planner.planWarmup
  // ──────────────────────────────────────────────────────────────────────────
  warmupRules: [
    {
      id: 'set-bio',
      when: (s) => !s.profile?.bioSet,
      reason: () => 'Bio is unset — completing profile is the precondition for warming up.',
      produce: (s, ctx) => ({
        campaignId: ctx.campaignId,
        type: 'set_profile',
        riskLevel: 1,
        payload: {
          bio: s.pinned?.bio ?? `Building ${ctx.productName} — ${ctx.productOneLiner}`.slice(0, 500),
        },
      }),
    },
    {
      id: 'set-avatar',
      when: (s) => !s.profile?.avatarSet,
      reason: () => 'Avatar is unset — campaigns supply a logo URL.',
      produce: (s, ctx) => ({
        campaignId: ctx.campaignId,
        type: 'set_profile',
        riskLevel: 1,
        payload: ctx.avatarUrl ? { avatar: ctx.avatarUrl } : {},
      }),
    },
    {
      id: 'set-website',
      when: (s) => !s.profile?.websiteSet,
      reason: () => 'Website is unset — adds credibility before engagement.',
      produce: (s, ctx) => ({
        campaignId: ctx.campaignId,
        type: 'set_profile',
        riskLevel: 1,
        payload: { website: s.pinned?.website ?? ctx.productUrl },
      }),
    },
    {
      id: 'follow-peers',
      when: (s) =>
        Boolean(s.profile?.bioSet && s.profile?.avatarSet && s.profile?.websiteSet) &&
        (s.warmup?.followsCompleted ?? 0) < MIN_FOLLOWS,
      reason: (s) =>
        `Only ${s.warmup?.followsCompleted ?? 0}/${MIN_FOLLOWS} peer follows so far — building social graph.`,
      produce: (_s, ctx) => ({
        campaignId: ctx.campaignId,
        type: 'follow',
        riskLevel: 2,
        payload: { topic: ctx.topic, count: 3 },
      }),
    },
    {
      id: 'upvote-peers',
      when: (s) =>
        Boolean(s.profile?.bioSet && s.profile?.avatarSet && s.profile?.websiteSet) &&
        (s.warmup?.upvotesCompleted ?? 0) < MIN_UPVOTES,
      reason: (s) =>
        `Only ${s.warmup?.upvotesCompleted ?? 0}/${MIN_UPVOTES} upvotes so far — IH karma needs activity.`,
      produce: (_s, ctx) => ({
        campaignId: ctx.campaignId,
        type: 'upvote',
        riskLevel: 2,
        payload: { topic: ctx.topic, count: 3 },
      }),
    },
    {
      id: 'helpful-engagements',
      when: (s) =>
        Boolean(s.profile?.bioSet && s.profile?.avatarSet && s.profile?.websiteSet) &&
        (s.warmup?.engagementsCompleted ?? 0) < MIN_ENGAGEMENTS,
      reason: (s) =>
        `Only ${s.warmup?.engagementsCompleted ?? 0}/${MIN_ENGAGEMENTS} helpful engagements — replies build karma faster than upvotes.`,
      produce: (_s, ctx) => ({
        campaignId: ctx.campaignId,
        type: 'engage',
        riskLevel: 3,
        payload: { topic: ctx.topic },
      }),
    },
  ],
}
