# Platform Extensibility — How We Add New Platforms Without Rewriting Code

## 1. The question

> "If this is a fully autonomous system, picking platforms / maintaining
> accounts / running ops should be auto-decided. Every new platform later
> can't mean writing new code."

Correct. The current `IndieHackersAdapter` class is a transitional
implementation that mixes three things which should be separated:

1. **Stable infrastructure** — should be code, written once, never changed
   per-platform.
2. **Per-platform knowledge** — should be data (manifests), editable by
   anyone, eventually auto-discovered by an onboarding agent.
3. **Per-campaign reasoning** — should be LLM decisions at runtime, never
   hardcoded.

This document defines that split and the migration path.

## 2. Layered architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Layer 3 — Per-campaign LLM decisions  (CHANGES EVERY USER)      │
│   • Which platforms to use for this product?                    │
│   • What's the right post for this audience?                    │
│   • When should we give up on a platform?                       │
│   • How do we allocate karma-building effort across platforms?  │
│   Implementation: Strategist + Writer + Critic agents           │
├──────────────────────────────────────────────────────────────────┤
│ Layer 2 — Per-platform manifests  (CHANGES WHEN PLATFORM DOES)  │
│   • URLs, capability matrix, login probe                        │
│   • Action templates: post / comment / set_profile / upvote ... │
│   • Block-detection patterns                                    │
│   • Warm-up recipe                                              │
│   • Risk + cap policy                                           │
│   Implementation: TypeScript manifest files in `platforms/*.ts` │
├──────────────────────────────────────────────────────────────────┤
│ Layer 1 — Stable infrastructure  (CHANGES RARELY, ENGINEERED)   │
│   • Browser runtime + persistent profiles                       │
│   • Computer-use agent loop                                     │
│   • Queue + worker + scheduler                                  │
│   • RAG memory store                                            │
│   • DB schema                                                   │
│   • Generic ManifestBrowserAdapter (reads manifests, runs them) │
│   Implementation: existing src/lib/* code                       │
└──────────────────────────────────────────────────────────────────┘
```

### What this gets us

- **Adding a new platform** = create one `<platform>.manifest.ts` file.
  No new class, no logic changes.
- **Updating a platform after a UI change** = edit the manifest's selectors
  hints / probe text. No code review needed for prompt-only changes.
- **An onboarding agent** can fill out a draft manifest from just a URL
  by exploring the site, lowering the barrier to "we support that too".
- **The strategist agent** consumes manifests as data when deciding
  which platforms fit this user's product.

## 3. The PlatformManifest type

Defined in `src/lib/platforms/manifest.ts`. Three subsections:

```ts
interface PlatformManifest {
  // ── Identity ──
  id: PlatformId
  displayName: string
  baseUrl: string
  loginUrl: string
  dashboardUrl: string

  // ── Probes (used by connect:account, browser:check, run-time) ──
  loginProbe: {
    loggedInTextMarkers: string[]
    loggedOutUrlMarkers: string[]
    loggedOutTextMarkers?: string[]
  }

  // ── Capability matrix (drives risk + cap engine) ──
  capabilities: PlatformCapabilities      // see types.ts
  defaultRiskByActionType: Partial<Record<ActionType, RiskLevel>>

  // ── Action recipes (what goal prompts, what payload schema) ──
  actions: {
    [type in ActionType]?: ActionRecipe
  }

  // ── Block detection (cooldown enforcement) ──
  blockedHints: BlockedHint[]            // e.g. /karma threshold/i → karma_threshold
  defaultCooldownHoursByReason: Record<CooldownReason, number>

  // ── Warm-up plan (ordered grooming recipe) ──
  warmupRecipe: WarmupRule[]
}

interface ActionRecipe {
  /** Zod schema for `payload`. */
  payloadSchema: z.ZodTypeAny
  /** Goal-prompt template. Strings of the form `{{key}}` are interpolated
      from the payload. The agent receives this as the high-level goal. */
  goalTemplate: string
  /** Optional override for the start URL (defaults to manifest.baseUrl). */
  startUrl?: string | ((payload: any) => string)
  /** Step + wallclock budgets. */
  maxSteps?: number
  maxWallclockMs?: number
  /** Hooks for what to do on success — typically updates account_state. */
  onSuccess?: 'recordUpvote' | 'recordFollow' | 'recordEngagement'
                                       | 'recordProfileFields' | 'none'
}

interface WarmupRule {
  /** When does this rule fire? */
  when: (state: AccountState) => boolean
  /** What action does it produce? */
  produce: (ctx: WarmupContext) => Omit<ActionRequest, 'userId'>
  /** Human-readable rationale, persisted to decision_logs. */
  reason: string
}
```

### What stays in code

- The generic `BrowserPlatformAdapter` class (~1 file, ~150 lines) that
  consumes any manifest and runs it.
- The shared `runWithCooldown` helper, `BLOCK_DETECTION_ADDENDUM` text,
  and the agent loop. None of this varies per platform.
- The warmup planner's *engine* (which iterates `WarmupRule[]`); the
  individual rules live in the manifest.

## 4. Onboarding new platforms — three modes

### 4.1 Manual (today) — write a manifest by hand

```
src/lib/platforms/manifests/lobsters.manifest.ts
```

A junior dev / a non-engineer with TS basics can produce this in an
afternoon. No build, no migration, no class.

### 4.2 Assisted — LLM drafts the manifest from a URL

`pnpm dev:onboard-platform https://lobste.rs`

The onboarding agent:

1. Browses the site without login → finds login URL, dashboard URL.
2. After the user does `connect:account`, browses again → identifies the
   logged-in markers, the post page, the profile page.
3. Tries each candidate action with a tiny synthetic payload (or in
   "describe-only" mode) → fills `actions.*.goalTemplate`.
4. Searches the site's docs / community guidelines → fills `blockedHints`
   and `warmupRecipe`.
5. Emits a draft `<platform>.manifest.ts` for human review.

Most of this is just runBrowserTask with a different system prompt.
The LLM does the analysis; the data lands in version control.

### 4.3 Inferred — strategist picks unknown platforms at runtime

The strategist agent (Layer 3) decides which platforms a campaign should
target. If it picks one without a manifest, it triggers 4.2 first, gets
a draft manifest, asks the user to confirm, then proceeds.

Manifest review is the human-in-the-loop bottleneck — but it's
**per-platform-once**, not per-campaign or per-action. The economics
work.

## 5. What the strategist agent decides at runtime (Layer 3)

The strategist is a deterministic LLM call given:

- Campaign config (product, audience, ICP)
- All available manifests (capability matrices, ToS rules)
- Historical performance from `metrics_snapshots` (RAG-retrieved)
- Account state per platform

It outputs a typed `CampaignPlan`:

```ts
{
  platforms: {
    indie_hackers: { priority: 'high',   budget_actions_per_week: 14 },
    reddit:        { priority: 'medium', budget_actions_per_week: 5,
                     subreddits: ['r/chrome_extensions', 'r/SideProject'] },
    hacker_news:   { priority: 'high',   budget_actions_per_week: 1,
                     plan: 'Show HN once karma >= 50' },
    x:             { priority: 'medium', budget_actions_per_week: 7 },
    product_hunt:  { priority: 'high',   plan: 'launch_day = Tuesday' },
  },
  rationale: '...',
}
```

This plan is **regenerated** weekly (or when something changes — account
gets banned, metrics show a platform performing 10× another, user adds
new ICP). The supervisor consumes the plan and dispatches grooming +
content actions accordingly.

## 6. Migration path from today's code

| Step | Status | Outcome |
|---|---|---|
| 6.1 — Define `PlatformManifest` type + meta-schema | ✅ done | The contract exists in `src/lib/platforms/manifest.ts`. |
| 6.2 — Extract `IndieHackersAdapter` into `indie-hackers.manifest.ts` | ✅ done | IH is data, not code. |
| 6.3 — Build `ManifestBrowserAdapter` consuming any manifest | ✅ done | `src/lib/platforms/adapters/manifest-adapter.ts`. |
| 6.4 — Update `registry.ts` to load manifests dynamically | ✅ done | New manifests auto-register via `manifests/index.ts`. |
| 6.5 — Build `dev:onboard-platform` agent | pending | Drafts manifests from URLs. |
| 6.6a — Strategist v0.1 (AudienceMapper) | ✅ done | `dev:strategy` ranks platforms by audience fit + flags missing ones. |
| 6.6b — Strategist v1 (CampaignPlan persistence + supervisor integration) | pending | Plans saved per campaign, drive scheduling. |

### 6.6a — Strategist v0.1 (AudienceMapper)

Implemented in `src/lib/strategy/audience-mapper.ts`. Reads each manifest's
`audienceProfile` (summary + tags + notSuitableFor) and a campaign's
audience description, asks the analyst LLM for a fit score (0..1),
rationale, and 1-5 platform-specific tactics per platform. Also surfaces
`missingPlatforms[]` — known audience hubs we have no manifest for yet
(LinkedIn, niche forums, etc.).

Validated against docMask (legal redaction Chrome extension): mapper
correctly flagged Indie Hackers and Hacker News as low fit, ranked CWS
and owned blog highest, and surfaced LinkedIn as the top missing
manifest. Cost ~$0.001 per call.

Run: `pnpm dev:strategy [fixture.json]` (defaults to docMask fixture).

## 7. What we're NOT doing

- **Fully zero-shot platforms.** We don't claim the agent can land on
  example.com today and figure out how to be a power user without any
  manifest. That's a research problem. We require a manifest, but make
  the manifest cheap to produce.
- **Agent-edits-its-own-prompts.** Manifests are read by the system, not
  modified by it autonomously. Updates go through git or a staged
  human-approved review step. This is a safety guarantee — agents
  cannot rewrite their own ToS guardrails.
- **Hidden manifest changes.** All manifest edits show up in version
  control. Auditable.
