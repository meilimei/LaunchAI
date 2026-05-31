# LaunchAI → Mosaiq Cloud — Outstanding Integration Requests

This file collects feature requests / API clarifications LaunchAI has against
[Mosaiq Cloud](https://github.com/meilimei/Mosaiq), written for hand-off to
the Mosaiq maintainers. Each request is self-contained: status, motivating
use case, proposed API surface, acceptance criteria, and the LaunchAI-side
files that will pick the change up.

The intent is that a Mosaiq contributor can open one section and start
committing without needing to read this whole document or re-derive the
LaunchAI use case.

LaunchAI-side runtime adapter for Mosaiq: `src/lib/browser/runtime-mosaiq.ts`.
Mosaiq SDK consumed: `@mosaiq/cloud-sdk` (npm-linked, pre-publish).

---

## Request 1 — Phase 11.5: `keepAlive: true` long sessions + sticky pod routing

**Status**: Drafted by LaunchAI 2026-05-26. Mosaiq has no `docs/PHASE-11.5-*.md`
yet. The Phase 11.4 Stagehand-compat doc explicitly defers `keepAlive: true`
to phase 11.5 (see `Mosaiq:docs/PHASE-11.4-STAGEHAND-COMPAT.md` §4 table
row 9 and §7 line "❌ `keepAlive: true` 长 session 保活—— phase 11.5").
This request is the spec for that phase.

**Mosaiq prior art already in place**:
- Phase 11.4 commit 2 added the BB-compat `keepAlive` field to
  `shapeSession()` response (currently hard-stubbed to `false`).
- Phase 11.4 commit 3 added `keepAlive` to the BB-shape request body parser
  but warn-and-ignores it. Honoring the flag is the missing piece.
- Phase 11.4 commit 2 added the `userMetadata jsonb` column on
  `sessionsTable`. This is the natural place to land the `stickyKey`
  proposed below — no new column needed.
- Phase 11.3a established the single-use safety invariant (every pool
  entry consumed → destroyed → replenished from a fresh microVM). Phase
  11.5 MUST NOT break that invariant for normal (`keepAlive: false`)
  sessions; only `keepAlive: true` sessions get the new lifecycle.

---

### 1.1 Motivating use case (LaunchAI side)

LaunchAI runs "account grooming" cycles against social platforms (Reddit,
Indie Hackers, X, Hacker News, Product Hunt). One cycle of `pnpm dev:warmup
<platform> --execute` is sub-30s, well inside today's `ttlSeconds: 1800`
default (`runtime-mosaiq.ts:93`). The pain is **across** cycles:

1. **Reddit revival (2026-05-26)** — `src/lib/platforms/manifests/reddit.manifest.ts`
   was revived with a daily action cap of 3. That means up to 3 separate
   `dev:warmup reddit --execute` invocations across a 24h window. Today
   each invocation:
   - allocates a fresh Mosaiq session (cold or warm pool acquire, ~22–40s)
   - logs in via cookies from LaunchAI's `BrowserStorageState`
   - performs one grooming action
   - closes the session, **destroying the pod**
   - on the next invocation, the cookies replay fine but the pod's
     IndexedDB / Service Worker state from `new.reddit.com` is gone (it
     lived in `--user-data-dir` of the previous, now-destroyed microVM —
     see `runtime-mosaiq.ts:122-124` comment block)

2. **new.reddit.com PWA / Service Worker fingerprint** — Reddit's new
   front-end installs a SW and writes feed-cache, push-subscription, and
   recently-visited subs into IndexedDB. A 0-day-old SW on every visit is
   a soft anti-bot signal (real users have weeks of SW state). Cookies
   alone don't reproduce this; the storage stack has to survive across
   sessions.

3. **Generalizes to other long-lived grooming platforms** — Indie Hackers
   and HN both have CSRF tokens with multi-hour lifetimes that are kept
   in localStorage, not just cookies. The same `keepAlive` story applies.

LaunchAI's accountant tier in our PRD maps to Mosaiq's **Scale tier**
(`Mosaiq:docs/PRD.md` §3 pricing table, row "Scale $499/mo: 专属 + sticky").
Phase 11.5 is what makes that tier deliverable.

---

### 1.2 Proposed API surface

#### 1.2.1 Honor `keepAlive: true` in `POST /v1/sessions` (BB-shape body)

Today `keepAlive` is parsed and warned. New behavior:

```jsonc
// BB-shape request body
{
  "keepAlive": true,          // request long-lived session
  "userMetadata": {
    "stickyKey": "launchai:user_42:reddit"  // see §1.2.3
  },
  "viewport": { "width": 1920, "height": 1080 }
}
```

Server-side effects when `keepAlive: true`:
- TTL upper bound raised from current 30 min default to **24 h** (configurable
  via `SESSION_TTL_MAX_KEEPALIVE_SECONDS`, default `86400`). Per-request
  `ttlSeconds` still respected up to that ceiling.
- On WS disconnect, **DO NOT** destroy the pod. Leave it in `running` state
  with the chromium process alive and `--user-data-dir` intact.
- Session row stays `status='active'` until either:
  - client calls `DELETE /v1/sessions/{id}` (explicit close)
  - the configured idle timeout elapses with no WS reconnect (default 1h,
    env `SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS`)
  - the configured hard TTL elapses (`expiresAt` reached)
- On reconnect (`chromium.connectOverCDP(connectUrl)` from a new client),
  the same pod is rejoined. IndexedDB / SW state survives because nothing
  destroyed the volume.

Response shape unchanged from Phase 11.4 — `keepAlive: true` in response
when the request asked for it.

#### 1.2.2 `GET /v1/sessions/{id}` reflects accurate `keepAlive`, `endedAt`

When `keepAlive: true` and the session is idle (WS disconnected but pod
alive), `endedAt` stays `null` and `status='active'`. When it transitions
to truly closed (TTL hit, idle hit, or explicit DELETE), `endedAt`
populates and `status='closed'`. This matches BB semantics — Stagehand
users polling `GET /v1/sessions/{id}` should see the same shape they'd
see from Browserbase.

#### 1.2.3 `stickyKey` — sticky pod routing

A new opt-in field inside `userMetadata`. Convention is namespaced
strings, e.g. `"launchai:user_42:reddit"`, `"customer-abc:campaign-7"`.
Mosaiq does not parse the contents — it's an opaque key.

Routing contract:
- If a `POST /v1/sessions` with `keepAlive: true` includes
  `userMetadata.stickyKey`, the server looks up an in-memory
  `Map<stickyKey, sessionId>`:
  - **hit** + the existing session is still `active` → 409 `session.sticky_conflict`
    with body `{ existingSessionId, expiresAt }`. Client can either rejoin
    via `connectOverCDP(existingSession.connectUrl)` or call DELETE first
    and retry. **Do not silently rejoin** — that would be ambiguous if the
    client thought it was creating a new session.
  - **hit** but the existing session is `closed`/`expired` → evict the
    map entry and proceed with a fresh allocation, populating the map
    with the new session id.
  - **miss** → fresh allocation, populate the map.
- The map entry is removed when the session transitions to `closed`
  (whether via TTL, idle, or explicit DELETE).
- The map is process-local (cloud-runtime instance). If we ever scale
  cloud-runtime horizontally, Phase 11.5b needs a Redis-backed map; for
  now single-instance is fine and matches the rest of Phase 11.x state.

#### 1.2.4 Optional: `POST /v1/sessions/{id}/reconnect` ergonomic endpoint

Not strictly needed — clients can just `connectOverCDP(existingSession.connectUrl)`
directly — but a no-op REST call that returns the same shape as create
makes Stagehand-style clients' code path uniform. Phase 11.5b nice-to-have.

---

### 1.3 Single-use safety carve-out (critical)

Phase 11.3a §6 line 58 makes this commitment:

> 4. safety story 干净：每个 pool entry single-use——consume 后 destroy，
>    replenish 用新 machine。chromium 永远从全新 microVM 起，无 cookies /
>    DOM storage / history / fingerprint state 跨 session 泄漏。

Phase 11.5 must preserve this for `keepAlive: false` sessions. The
proposed carve-out:

- `keepAlive: false` (default) → unchanged. Pool entry consumed,
  destroyed on close, replenished from a fresh microVM. Single-use
  invariant preserved. This is the path the **vast majority** of
  Stagehand users will take (they don't set `keepAlive`).
- `keepAlive: true` → pod survives across close-and-rejoin within the same
  session id. Cross-session state is scoped to the **same stickyKey**, which
  is opaque to Mosaiq. If a customer reuses a stickyKey across logically
  different identities, that's their own data-leakage problem, not Mosaiq's
  — same as if they reused a Browserbase context id.

To make the carve-out visible in pool metrics, add labels:
- `mm_acquire_duration_seconds{keepalive="true"|"false"}`
- `pool_consumes_total{keepalive="true"|"false"}`

---

### 1.4 Acceptance criteria

#### 1.4.1 Code

- [ ] `POST /v1/sessions` with `keepAlive: true` (BB-shape) returns 201
      and the response `keepAlive: true`.
- [ ] Same with `userMetadata.stickyKey: "test"` succeeds; second
      identical POST returns 409 `session.sticky_conflict` with the
      first session's id + expiresAt.
- [ ] WS disconnect on a `keepAlive: true` session: pod stays in
      `running` state on Fly; session row stays `status='active'`;
      a re-`connectOverCDP(connectUrl)` from the same client succeeds.
- [ ] IndexedDB persistence across the disconnect/reconnect cycle:
      `await page.evaluate(() => indexedDB.databases())` after reconnect
      lists the DB created before the disconnect. (Reddit's SW database
      is `localforage`; any small repro is fine.)
- [ ] `keepAlive: false` (default) sessions still single-use destroy
      on close — Phase 11.3a §6 invariant test stays green.
- [ ] Idle timeout fires: `keepAlive: true` session left without WS
      reconnect for `SESSION_IDLE_TIMEOUT_KEEPALIVE_SECONDS` transitions
      to `status='closed'` and pod is destroyed.
- [ ] Hard TTL still enforced: `keepAlive: true` session whose
      `expiresAt` passes is closed regardless of activity.
- [ ] `mm_acquire_duration_seconds{keepalive="true"}` counter increments
      on keepalive acquires; `keepalive="false"` increments on normal
      acquires. Both visible in `/v1/metrics`.

#### 1.4.2 Cross-repo smoke

- [ ] LaunchAI bumps `runtime-mosaiq.ts:93` to use `keepAlive: true`
      + `ttlSeconds` driven by platform manifest (Reddit 86400, others
      keep 1800). `pnpm dev:warmup reddit --execute` succeeds twice in
      a row within the same 24h window and the **second** invocation
      reuses the same Mosaiq session id (verified via the trajectory
      log + Mosaiq `/v1/sessions/{id}` GET).
- [ ] After the two invocations, `await page.evaluate(...)` against
      `new.reddit.com` reports a populated `localStorage` and at least
      one IndexedDB database — proof that PWA/SW state survived.

#### 1.4.3 Docs

- [ ] `Mosaiq:docs/PHASE-11.5-KEEPALIVE-LONG-SESSION.md` exists and
      mirrors this request's shape (motivation, API, lifecycle diagram,
      acceptance criteria filled with real measurements).
- [ ] `Mosaiq:docs/PRD.md` §3 Scale tier "sticky" feature column links
      to PHASE-11.5 doc (closes the PRD ↔ implementation gap).
- [ ] `Mosaiq:docs/PHASE-11.4-STAGEHAND-COMPAT.md` §4 table row 9
      updated from `⚠️ phase 11.5` to a checkmark + back-link.

---

### 1.5 LaunchAI-side files that will pick this up

| File | Change after Phase 11.5 lands |
|---|---|
| `src/lib/browser/runtime-mosaiq.ts:93` | `ttlSeconds: 1800` → manifest-driven; add `keepAlive: true` + `userMetadata.stickyKey: "launchai:${userId}:${platform}"` |
| `src/lib/browser/runtime-mosaiq.ts:122-124` | Remove TODO comment about "Phase 11.3 (sticky pod routing)" — replace with Phase 11.5 reference + drop the warning about IndexedDB/SW loss |
| `src/lib/platforms/manifests/reddit.manifest.ts:26-32` | Update header history: Phase 11.5 is the actual dependency, not the phantom `Mosaiq:docs/PHASE-11.3-MACHINE-POOL.md §8` reference currently there |
| `src/lib/platforms/manifest.ts` (PlatformCapabilities) | Add optional `sessionTtlSecondsHint?: number` so each manifest can advertise its preferred TTL to the runtime adapter |

---

### 1.6 Out of scope for this request

- ❌ Multi-instance cloud-runtime sticky map (Redis-backed) — Phase 11.5b
  if/when cloud-runtime scales horizontally.
- ❌ Migrating Browserbase Contexts API semantics (`browserSettings.context.id`
  field) — that's the **persistent-cookie-jar** model, which is orthogonal
  to keepAlive (BB users can have either independently). Phase 11.6.
- ❌ Stripe metering for keepAlive idle-time minutes — Phase 11.7 billing.
- ❌ Recording / replay for keepAlive sessions — M9.

---

### 1.7 Risk + open questions

| # | Question | LaunchAI proposed default |
|---|---|---|
| 1 | `userMetadata.stickyKey` collision across customers — what if customer A and customer B both use `"reddit:main"`? | Scope the map by `(projectId, stickyKey)` not just stickyKey. Trivial extra dimension, prevents cross-tenant routing. |
| 2 | If pool is at capacity (`POOL_TARGET_SIZE` saturated) and a `keepAlive: true` request arrives, do we evict an idle keepalive session or queue the request? | Phase 11.5 MVP: 429 `pool.saturated` with `Retry-After`. LRU eviction is Phase 11.5b. |
| 3 | Cost: keepAlive sessions don't get the "stopped machine ~$0.15/GB·mo" benefit; they cost `~$1.9/day` per running pod. Should we expose a per-customer cap? | Yes — add `KEEPALIVE_SESSIONS_PER_PROJECT_MAX` env (default 5). Returns 429 when exceeded. Matches PRD Scale tier "10 concurrent". |
| 4 | If the same client reconnects to a `keepAlive` session from a different IP / proxy, do we care? | No — that's the customer's transport story. BB doesn't enforce this either. |

---

## (Future request slots — append below when needed)
