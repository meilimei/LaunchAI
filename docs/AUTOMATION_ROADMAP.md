# Automation Roadmap — How Warmup and Action Execution Run

This document answers one question: **where and how does the code that opens
Chromium, drives the account, and records the result actually execute** —
today, at alpha, and at scale?

It is an architecture decision record. Revisit it before any "should we
stand up a worker / move to Vercel Cron / buy Browserbase" discussion.

## 1. Today (dev / n=1 account)

- Every action is triggered **manually** by running `pnpm dev:warmup <platform> --execute`
  or `pnpm dev:run-action <...>`.
- The script executes **one step** (`plan.steps[0]`), persists side-effects
  (`account_state` counters, cooldowns), prints the trajectory, and exits.
- Chromium runs **headful** on the developer machine (`BROWSER_HEADFUL=1`).
- `browser_sessions` (cookies, storage state) live in local Postgres.

There is no supervisor, no queue, no cron. The only reason this works is
that `dailyActionCap: 1` on every platform means "one engage per account
per day" — a human clicking a terminal once a day is not the bottleneck.

## 2. Terminal architecture (at launch / post-launch)

The target shape, chosen deliberately and recorded here so we stop
revisiting it every two weeks:

| Layer | Choice | Why |
|---|---|---|
| UI + API | **Next.js on Vercel** (current) | Scale-to-zero; product surface. |
| Scheduling / queue | **Inngest** | Cron + step-function retries + fan-out + observability. Free 50k runs/mo. Integrates as a single Next.js API route. |
| Execution / browser | **Dockerized Playwright worker on Fly.io** (or Railway / Hetzner) | Full Chromium + Xvfb for headful, sticky machine IP, cheap ($2–10/mo per small machine, fits ~10–20 accounts). |
| Outbound IP | **Per-account sticky residential proxy** (Bright Data / Oxylabs) once >10 accounts | Re-using one IP for many accounts is the single biggest footgun with Reddit / HN / IH risk scoring. |
| DB | Supabase / Neon Postgres (current) | No change. |

The boundary that matters: **UI / API is serverless; execution is on
long-lived machines with stable egress IPs.** Those two concerns do not
belong in the same runtime.

### Event flow
```
 User (UI)              Next.js on Vercel              Inngest                 Fly.io worker
   │                          │                           │                          │
   │  click "Run warmup"      │                           │                          │
   ├─────────────────────────▶│                           │                          │
   │                          │  inngest.send(            │                          │
   │                          │   "warmup/tick")          │                          │
   │                          ├──────────────────────────▶│                          │
   │                          │                           │  HTTP POST /inngest      │
   │                          │                           ├─────────────────────────▶│
   │                          │                           │                          │  runOneTick(...)
   │                          │                           │                          │  ├ planWarmup
   │                          │                           │                          │  ├ adapter.executeAction
   │                          │                           │                          │  │  └ Playwright in Xvfb
   │                          │                           │                          │  └ persist state + trajectory
   │                          │                           │◀─────────────────────────┤
   │                          │  read from DB             │  ack + next schedule     │
   │◀─────────────────────────┤                           │                          │
```

The worker is **stateless** — every request rehydrates from Postgres
(session, account_state, campaign). That is what makes worker crashes and
multi-region deployment cheap.

## 3. What we deliberately did NOT choose

| Option | Why we rejected it |
|---|---|
| **Vercel Cron + serverless Playwright** (`@sparticuz/chromium`) | No headful mode. Cold-starts 3–10s each action. 300–900s function timeout is tight for long engage runs. **Rotating egress IP** per invocation — account-trust killer. |
| **AWS Lambda + custom Chromium layer** | Same IP rotation problem as Vercel. Cold-start and layer management add a 2-week yak shave for no win over Fly.io. |
| **Node `setInterval` inside the Next.js process on Vercel** | Vercel serverless functions don't survive long-lived timers; function sleeps kill the interval. |
| **node-cron on the dev box as the production plan** | Works for one developer; cannot onboard a second user without re-architecting. |
| **Browserbase / Hyperbrowser as the primary executor** | Per-session $0.02–0.5 stacks up fast; another rate limit; session data lives in their account not ours. Good as a **fallback** when a worker is unhealthy or for one-off runs with residential IP — not the main path. |
| **K8s / ECS for the worker pool** | Zero operational headroom at alpha. Fly.io's machine model is strictly simpler and handles 10× our projected load for a year. |

## 4. Migration path — stages, not a cliff

Each stage has an explicit trigger condition. We only do the migration
work when the trigger fires, not "because it felt about time".

### Stage 0 — manual CLI (current)
- Trigger to exit: HN engage has succeeded **≥3 consecutive runs** with
  real permalinks AND IH engage has succeeded **≥3 times** with real
  permalinks.
- Rationale: self-driving the account while prompts are still being tuned
  guarantees we see every failure mode on the terminal. Automation at this
  stage hides prompt-quality regressions.

### Stage 1 — local loop script (single machine, single user)
- `scripts/warmup-loop.ts` iterates all connected `(userId, platform)`,
  computes `next_eligible_at`, sleeps until the earliest, invokes
  `runOneTick()`, repeats.
- Windows Task Scheduler can either launch this at login (keeps it alive)
  or invoke `pnpm warmup-once` once a day.
- Trigger to exit: **more than one concurrent user** OR dev machine sleep
  becomes a problem.
- Code change needed to enter: extract `runOneTick({ userId, platform })`
  from `scripts/dev-warmup.ts` into `src/lib/warmup/run-one-tick.ts`.
  `dev-warmup.ts` becomes a thin CLI wrapper over it; the loop script is
  another thin wrapper; the future Inngest handler is a third wrapper.
  **The work is zero-risk (pure refactor) and pays off in all three
  downstream stages.** Do it first.

### Stage 2 — single Fly.io worker + Inngest cron (first 1–10 users)
- Fly.io machine runs the worker Docker image. Inngest `scheduled` events
  fire (e.g., every 15 min); the handler calls `runOneTick` for each
  eligible account.
- Next.js UI gains a "pause / resume warmup" button that sends an Inngest
  event.
- Trigger to exit: **>10 concurrent accounts** starts stressing sequential
  execution on one machine, OR risk signals appear from shared IP.

### Stage 3 — worker pool + per-account sticky proxy (10+ users)
- Inngest concurrency control (`concurrency.key = "${userId}:${platform}"`)
  ensures one in-flight action per account; Fly.io auto-scales workers
  based on queue depth.
- Integrate Bright Data / Oxylabs sticky residential sessions: one
  session_id per platform account, stored in `browser_sessions.proxyRef`.
- Optional: Browserbase as a failover when a Fly worker is marked
  unhealthy. Not a replacement.

### Stage 4 — global footprint, if ever
- Regional worker pools (Fly has dozens of regions) so a Japanese user's
  Reddit account egresses from Japan.
- Per-region DB replicas or a globally-distributed DB (Neon / PlanetScale).

We are **not planning** beyond Stage 3 here. If we hit Stage 4 we have
bigger problems than this doc can anticipate.

## 5. Code investments we should make now (keep Stage 0 → 2 cheap)

These are the things that, if we don't do them early, force rewrites later.

1. **Extract `runOneTick` pure function** (as described in Stage 1). Do
   this the next time we touch `dev-warmup.ts`. Thirty minutes of work,
   unlocks all three future execution shapes.
2. **Keep `runOneTick` free of `process.env` side-effects.** Any config
   (headful on/off, proxy, timeouts) should be passed as arguments. The
   dev CLI reads env and passes; the worker reads Inngest event payload
   and passes. This keeps the function unit-testable.
3. **Never write session state to disk.** Always `browser_sessions` in
   Postgres. Current code already does this; just don't regress it. A
   worker that writes to local disk is one worker we can never have two
   of.
4. **Keep every platform adapter idempotent per run.** An engage that was
   partially executed must not produce two replies if the worker restarts
   mid-action. The existing `validateMutationProof` + finish-contract
   shape handles the common case; check-before-write remains the agent's
   responsibility in the workflow.
5. **Log trajectory JSON to `tmp/` locally, to S3-compatible storage in
   the worker.** Add the S3 writer behind the same interface the CLI uses
   when we get to Stage 2. Do not invent a new log format.
6. **Do not build a scheduler.** Use Inngest when the time comes. The
   planner (`planWarmup`) is pure and doesn't need one; everything else
   should be vendor-provided.

## 6. Open questions (not blocking, but track)

- **Proxy topology**: 1 sticky IP per account vs. 1 per user vs. rotation
  pool. Provisional answer: 1 per account. Revisit with real numbers
  after Stage 2.
- **Browser version pin**: Playwright bundles Chromium; upgrades can
  break selectors. Pin in `package.json`, update in a dedicated PR with
  smoke tests on each platform.
- **Observability**: Trajectory JSON is the source of truth for "what
  happened". A UI that renders it lives in Stage 2 / 3 territory. Do not
  invent a tracing system; render the JSON.
- **Multi-account per user on one platform** (e.g. one user runs two
  Reddit accounts). Every lookup key in the data model is already
  `(userId, platform)`. Extending to `(userId, platform, accountLabel)`
  is a future migration — not free, but local. Out of scope here.

---

**Current state (2026-05-01)**: Stage 0. Next action is *not* to build
Stage 1 — it is to finish proving prompt quality on HN and IH
(Stage-0 exit trigger) before any loop or worker touches production
accounts.

**Update (2026-05-02)**: Reddit autonomous posting deprecated. Stage-0
exit trigger now requires HN ≥3 + IH ≥3 (was Reddit ≥3 + HN ≥3).
Reddit manifest kept for draft-only output; removed from dev-warmup
VALID_PLATFORMS. See reddit.manifest.ts header.
