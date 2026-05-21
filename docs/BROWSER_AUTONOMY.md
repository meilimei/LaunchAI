# Browser Autonomy Design

> Status: design + initial implementation, May 2026
> Goal: lift LaunchAI execution from "API-where-allowed" to OpenClaw / Manus level browser-driven autonomy on platforms that expose no usable write API.

## 1. Why browser autonomy

Plan §3 honestly admitted that Product Hunt, Hacker News, and Indie Hackers do not expose third-party posting APIs. Without a browser-driven execution layer, those channels will never participate in a 90-day Full Autopilot campaign.

Browser autonomy unlocks:

- Posting where no API exists (PH, HN, IH, niche directories)
- Reading rich UI state that APIs do not return (PH ranking position, Reddit removal banners, HN mod queues)
- Updating listings on platforms that gate API write access (Chrome Web Store dashboard)
- Cross-platform actions that need a logged-in identity, not OAuth scope (DM, follow, profile edit)

It is the only credible way to deliver "user gives a URL → system does everything".

## 2. Scope honesty

**In scope**

- Operating user-owned accounts via persistent browser sessions
- Computer-use style agent loop (observe → plan → act → verify)
- Cookie / storageState persistence across worker restarts
- Local Playwright in dev, Browserbase in prod
- Per-platform action vocabulary with risk gates and rate limits

**Out of scope, intentionally**

- **Auto-registering new accounts.** Every target platform enforces SMS verification + CAPTCHA + device fingerprinting. Auto-creation violates ToS, gets banned within hours, and exposes the user to permanent IP blocks. Even OpenClaw / Manus / Claude Computer Use do not auto-register; they operate accounts the human created. We adopt the same boundary.
- Vote farming, fake engagement, multi-account astroturfing.
- Bypassing CAPTCHA, 2FA, or device verification.
- Operating accounts the user does not own.

The user creates each account once, manually, in our managed browser. From then on, the agent runs without human intervention.

## 3. Onboarding model

```
1. User clicks "Connect Reddit" in dashboard.
2. LaunchAI starts a managed browser session (Browserbase in prod, headed Playwright in dev).
3. Browser opens reddit.com/login. User completes login (and any 2FA / CAPTCHA) themselves.
4. On detected post-login URL, agent captures `page.context().storageState()`.
5. storageState is encrypted at rest in `browser_sessions` table.
6. Future tasks reuse storageState — agent enters logged-in.
7. If the platform invalidates the session, adapter raises NeedsReauth and supervisor pauses that platform until user re-connects.
```

No password or 2FA secret ever leaves the user's hands.

## 4. Runtime abstraction

```
BrowserRuntime
  startSession({ userId, platform, headful?, startUrl? }) -> ManagedBrowser

ManagedBrowser
  page: Page          // Playwright page
  saveStorageState()  // snapshot of cookies + localStorage (diagnostic only)
  close()
```

### 4.1 Why persistent contexts (and not storageState)

Initial implementation used `chromium.launch()` + `newContext({ storageState })`
plus a JSONB column to ship cookies between runs. **This does not work for
many real platforms** because Playwright's `storageState()` only exports
**cookies + localStorage**, NOT IndexedDB or Service Workers.

Concrete failures observed:

- **Indie Hackers** uses Firebase Authentication. The auth token sits in
  IndexedDB (`firebaseLocalStorageDb`). storageState only carried
  `logged_into_firebase` (a flag), so restoring the session looked logged-in
  by cookies alone but every API call was unauthenticated.
- **X / Twitter** stashes a portion of session state in IndexedDB after
  certain anti-bot challenges complete.
- **Service-worker-driven PWAs** (e.g. some PH flows) lose registration
  across contexts.

Fix: `LocalPlaywrightRuntime` now uses `chromium.launchPersistentContext`
with an on-disk user-data-dir per `(userId, platform)`:

```
.browser-profiles/<userId>/<platform>/
```

Each session reuses the same dir, so cookies + localStorage + IndexedDB +
service workers + cache all persist across runs naturally — the same way
they would in a normal Chrome profile. `saveStorageState()` is kept as a
diagnostic snapshot (used by `pnpm browser:check`) but the source of truth
is the dir on disk.

Tradeoffs:

- One Chromium process per session — cannot pool across (userId, platform).
- Single-writer per profile dir — the runtime tracks open contexts and
  refuses a second concurrent launch with a clear error.
- The dir contains live cookies and auth tokens — `.gitignore`'d.
  Encryption-at-rest of the dir is a follow-up milestone.

### 4.2 Implementations

- `LocalPlaywrightRuntime` — for `pnpm dev:worker` and CI. Headful when
  `BROWSER_HEADFUL=1` or the caller passes `headful: true`.
- `BrowserbaseRuntime` — for production. Connects via CDP using
  `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`. Browserbase has its own
  session-persistence model (managed sessions + keepAlive) that solves the
  IndexedDB problem differently — we do not need persistent dirs there.

Selection is driven by `BROWSER_RUNTIME=local|browserbase` (default `local`).

## 5. Computer-use tool vocabulary

The agent loop receives a goal ("post the Reddit draft to r/chrome_extensions") and an observation (page summary or screenshot). It picks one tool per step.

```
navigate(url)
click(selector | role=, name=)
type(selector, text)
press(key)
wait_for_selector(selector, timeoutMs)
extract_text(selector?)
describe_page()        // LLM summary of viewport
finish(result | error)
```

Future additions: `screenshot()`, `read_dom_snapshot()`, `solve_captcha_handoff()` (returns a session URL the user can finish manually), `scroll(direction, amount)`.

The loop is bounded:

- max 25 steps per goal
- max 90 seconds wallclock
- mandatory `finish` to return cleanly
- if `finish` not reached, the action is recorded as `failed` with the trajectory dumped to `decision_logs`

This is intentionally narrow vs full Anthropic Computer Use — fewer affordances, cheaper LLM calls, easier to audit.

## 6. Per-platform execution mode

Each platform adapter declares one of:

- `api` — use OAuth API only (e.g. Twitter v2 with elevated access)
- `browser` — use browser session only (e.g. Hacker News, Indie Hackers)
- `hybrid` — try API first, fall back to browser (e.g. Reddit when subreddit blocks API posting)
- `browser_assisted` — agent prepares the action but a human must click final submit (e.g. Product Hunt launch submission, CWS listing publish)

The adapter's `executeAction` chooses the path based on capability, current rate limits, risk policy, and whether a session exists.

## 7. Risk gates with browser

Browser execution does not bypass safety. Additional gates:

- **Session ownership check** — verify the loaded session matches the userId who owns the campaign.
- **Per-platform action cap** — daily caps from `PlatformCapabilities.dailyActionCap` apply identically.
- **Cooldown after failures** — repeated `failed` browser actions trigger a per-platform cooldown.
- **Re-auth detection** — if the agent observes a login form mid-task, it stops and emits `NeedsReauth`.
- **Approval gate for level 4 actions** — listing edits, profile changes, password reset always require explicit user approval even on full autopilot.

## 8. Storage

New table `browser_sessions`:

| column | type | notes |
|---|---|---|
| id | text | nanoid |
| userId | text | fk users |
| platform | text | `reddit`, `x`, `product_hunt`, ... |
| storageState | jsonb | Playwright storage state, encrypted at rest in milestone B |
| status | text | `connected` / `expired` / `revoked` |
| accountLabel | text | human-readable handle from page |
| lastUsedAt | timestamptz | for stale-cookie eviction |
| expiresAt | timestamptz | platform-known expiry if any |
| createdAt / updatedAt | timestamptz | |

Encryption-at-rest is deferred to a follow-up milestone using `pgcrypto` or app-level KMS. Until then, storageState is treated like an OAuth refresh token: never logged, never returned in API responses, only readable inside worker process.

## 9. Implementation milestones

- **B0 — this commit**: schema, runtime abstraction, tool vocabulary, agent skeleton, platform registry executionMode column. No real platform adapter yet.
- **B1**: onboarding endpoint + UI. User can connect Reddit / X / IH and persist session.
- **B2**: first real browser adapter — Indie Hackers post-and-monitor.
- **B3**: Reddit hybrid adapter (API primary, browser fallback for subs that block API).
- **B4**: Product Hunt browser_assisted launch flow.
- **B5**: HN Show HN browser-driven submission.
- **B6**: Chrome Web Store listing update via browser (level 4, approval-gated).

Plan crossref: this work corresponds to Milestone 3 in `plans/autonomous-marketing-os-17b3d4.md`, with the extra honesty that most of milestone 3 is browser, not OAuth.
