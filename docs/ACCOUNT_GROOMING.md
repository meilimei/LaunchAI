# Account Grooming — Long-Lived Autonomous Account Operation

LaunchAI is not a "post automator". It is an **autonomous operator of the
user's social presence**. The agent owns the account from the day it is
connected: it warms it up, it builds reputation, it publishes content, and
it maintains relationships — within ToS — for as long as the user keeps it
running.

This document defines that operating model.

## 1. Lifecycle stages

Every connected `(userId, platform)` account moves through five stages.
The supervisor schedules different action types at each stage.

| Stage | Definition | What the agent does |
|---|---|---|
| **fresh** | Just connected, no public footprint yet. | Complete profile (avatar, bio, website). No posts. No comments. |
| **warming** | Profile complete, building reputation. | Follow domain peers. Upvote relevant posts. Helpful low-risk replies on others' posts. No self-promotion. |
| **posting_ready** | Platform-specific gating cleared (karma threshold / age / verification). | Publish first owned post. Continue light engagement. |
| **active** | Steady-state operator. | Posts on schedule, replies to incoming comments, maintains follow graph, upvotes peers. |
| **paused** | Cooldown / block / user opted-out / token expired. | Nothing executes for this account until block clears or user reconnects. |

Stage transitions are derived, not stored — they fall out of `account_state`.

## 2. Action vocabulary additions

Existing `ActionRequest.type` covered `post / comment / reply / crawl /
update_listing / send`. We add the **grooming** family:

| Type | Risk | Description |
|---|---|---|
| `set_profile` | 1 | Update avatar / bio / display name / website on the user's own profile. Owned-channel — low risk. |
| `follow` | 2 | Follow a list of usernames or "agent picks N peers in topic X". Reversible by user any time. |
| `upvote` | 2 | Upvote a list of URLs or "agent picks N posts about topic X". Reversible. |
| `engage` | 3 | Post a low-risk reply (helpful / curious / congratulatory) on someone else's post to build karma. **No self-promotion** — explicit rule in the agent system prompt. |

Existing `post` and `comment` are **higher risk** because they introduce
new content or self-promotional replies.

## 3. Account state model

Stored as a jsonb column on `browser_sessions.account_state`.

```ts
interface AccountState {
  /** Last-known stage. Recomputed on read. */
  stage?: 'fresh' | 'warming' | 'posting_ready' | 'active' | 'paused'

  /**
   * Profile completeness flags. Set after a successful `set_profile` action
   * verifies the field is populated on the platform.
   */
  profile?: {
    avatarSet?: boolean
    bioSet?: boolean
    displayNameSet?: boolean
    websiteSet?: boolean
    /** Free-form notes from the agent's last profile read. */
    notes?: string
  }

  /** Counters used by the warm-up planner. */
  warmup?: {
    followsCompleted?: number
    upvotesCompleted?: number
    engagementsCompleted?: number
    /** ISO date strings, last 30 entries, for rate-limit policy. */
    recentActionTimestamps?: string[]
  }

  /**
   * Hard block from the platform. The supervisor MUST NOT enqueue any
   * write actions while now() < cooldownUntil.
   */
  cooldownUntil?: string  // ISO date
  /**
   * Why the cooldown was set. Helps the supervisor decide whether to
   * retry the same action class or pivot.
   */
  cooldownReason?:
    | 'new_account'
    | 'karma_threshold'
    | 'rate_limit'
    | 'verify_email'
    | 'captcha'
    | 'manual_review'
    | 'unknown'
  cooldownEvidence?: string  // page text quoted by the agent

  /** Hand-written user overrides — never overwritten by the planner. */
  pinned?: {
    bio?: string
    website?: string
    displayName?: string
  }
}
```

## 4. Cooldown detection — the contract

When the agent attempts a write action and the platform refuses, the
adapter must surface a **structured** result, not just `status: failed`.

The agent's `finish` tool is invoked with:

```ts
{
  success: false,
  output: {
    blocked_reason: 'new_account' | 'karma_threshold' | 'rate_limit' |
                    'verify_email' | 'captcha' | 'manual_review' | 'unknown',
    retry_after_hours?: number,    // if the platform stated a number
    evidence: string,              // verbatim text the agent saw
  },
  summary: '<one-line human description>',
}
```

The adapter parses `output`, computes `cooldownUntil`, and returns:

```ts
{
  status: 'deferred',
  cooldownUntil: <Date>,
  error: '<reason>: <evidence excerpt>',
  raw: { ...trajectory },
}
```

The supervisor then writes `account_state.cooldownUntil` and refuses to
schedule new write actions to that account until it elapses. Reads /
crawls / metrics are still allowed.

Default cooldown lengths when `retry_after_hours` is unstated:

- `new_account` → 24 h
- `karma_threshold` → 12 h (try grooming actions to build karma)
- `rate_limit` → 1 h
- `verify_email` → ∞ until user reconnects (paused stage)
- `captcha` → 6 h, retry; if recurs, paused
- `manual_review` → ∞ until user reconnects
- `unknown` → 6 h

## 5. Warm-up planner

Per-platform pure function:

```ts
planNextGrooming(state: AccountState, ctx: PlatformWarmupContext): GroomingPlan
```

Returns up to N actions in priority order. The supervisor picks the first
one that passes risk gates and enqueues it. After execution, the planner
runs again with updated state.

For Indie Hackers (initial plan):

```
1. if !profile.bioSet         → set_profile { bio: <generated from product> }
2. if !profile.avatarSet      → set_profile { avatar: <user's product logo> }
3. if !profile.websiteSet     → set_profile { website: <product url> }
4. if followsCompleted < 10   → follow { topic: <user's product domain>, count: 3 }
5. if upvotesCompleted < 15   → upvote { topic: <user's product domain>, count: 3 }
6. if engagementsCompleted < 5 → engage { topic: <user's product domain> }
7. → post  (the actual launch announcement)
```

The numbers are calibrated against IH's documented karma needs (no exact
threshold is published; we use observed-good defaults from existing IH
accounts and adjust as we learn).

## 6. Hard rules the agent always follows

These appear in every grooming-action system prompt as non-negotiables.

- **No fake engagement.** Never upvote / follow / reply to fabricate
  metrics. The peers we follow must be real, on-topic, and worth following
  from the user's authentic perspective.
- **No self-promotion in `engage`.** Replies during warm-up are about the
  parent post, not about our product. Helpful, curious, or congratulatory
  only. Mentioning the user's product belongs in `post` and `comment`.
- **One platform action per minute, max.** Hard rate-limit baked in to
  avoid bot-detection patterns regardless of what the planner asks for.
- **Stop on captcha.** If the agent sees a captcha during a grooming
  action, it does NOT solve it. It writes `cooldownReason: 'captcha'`
  and exits. Human judgment owns captcha resolution.
- **Profile content matches the user's voice.** Bio / display name /
  website come from the user's `Campaign` configuration; the agent only
  formats them. The agent never invents a persona.

## 7. What we explicitly do NOT do

- We never fabricate accounts, identities, or posts.
- We never run black-hat plays (vote manipulation, sockpuppets, follow-trains).
- We never delete or mass-edit a user's existing content unless the
  campaign explicitly requested it (risk level 4, double-confirm).
- We do not promise the user a specific karma number by date X. The system
  describes its plan, the user approves, results vary by platform.

## 8. Observability

Every grooming action writes a `decision_log` row with:

- The planner's reasoning (which rule fired, what state was)
- The agent's full trajectory (already supported via `runBrowserTask`)
- Page screenshots at key steps (milestone B7)
- Cooldown verdict + evidence

The dashboard renders this as a per-account timeline so the user can audit
every move at any time.

## 9. Milestones

- **G1 (this milestone)** — Schema + types + IH adapter for `set_profile`
  and `upvote` + cooldown detection in `post` + `dev:warmup` script.
- **G2** — `follow` and `engage` for IH; planner generates grooming
  contexts from the user's `campaign` row.
- **G3** — Reddit grooming (subreddit-aware, much stricter rules).
- **G4** — X / Twitter grooming.
- **G5** — Cross-platform supervisor that runs warm-up loops on schedule.
