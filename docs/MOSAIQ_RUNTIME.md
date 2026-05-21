# Mosaiq Runtime — Anti-Detection Browser Backend

> Status: Layer 1 landed. Layer 2 (humanize) + Layer 3 (proxy pool +
> Detection Lab scheduling) are planned in `docs/AUTOMATION_ROADMAP.md`.

## 1. Why

LaunchAI's existing `local` runtime uses
`chromium.launchPersistentContext` with only `--disable-blink-features=AutomationControlled`
as anti-bot hardening. This is good enough for Chrome Web Store / Product
Hunt / Indie Hackers (which don't gate on browser fingerprint), but
**insufficient for Reddit, X, and any platform behind Cloudflare-strict
rulesets** — these inspect:

- navigator.userAgentData (UA-CH), platform, vendor, hardwareConcurrency
- screen.\* / devicePixelRatio
- Intl / Date timezone
- Canvas / WebGL / Audio fingerprints
- WebGL ANGLE parameters (49 of them; UNMASKED\_VENDOR / RENDERER are the
  famous two but there are 47 more)
- WebRTC STUN candidate IPs
- ...and active behavior (mouse jitter, key timing)

[Mosaiq](https://github.com/meilimei/Mosaiq) is a persona-driven
anti-detection wrapper around Playwright that handles all of the above
via a CDP `Page.addScriptToEvaluateOnNewDocument` injection. It runs as a
separate package and is enabled in LaunchAI by switching the
`BROWSER_RUNTIME` env var.

## 2. Three-layer integration

| Layer | What ships | This PR? |
|---|---|---|
| **L1** | `runtime-mosaiq.ts` — drop-in `BrowserRuntime` impl. Env switch + persona-per-account isolation + Mosaiq's full fingerprint injection. **Existing agent / orchestrator / scheduler code unchanged.** | ✅ Yes |
| **L2** | `humanize-adapter.ts` — wrap `executeTool`'s `click` / `type` / `press` with Mosaiq's bezier mouse + lognormal keyboard timings. | ❌ Follow-up |
| **L3** | Per-account proxy pool, timezone-proxy alignment, weekly Detection Lab sweep → auto-pause on fingerprint regression. | ❌ Follow-up |

Each layer is independently shippable. Start with L1, measure Reddit
operating stability for a week, then decide whether to invest in L2/L3.

## 3. Setup (Layer 1)

### 3.1 Install Mosaiq SDK

Mosaiq is not on npm yet. Use a `file:` dependency:

```bash
# Clone Mosaiq alongside LaunchAI
git clone https://github.com/meilimei/Mosaiq.git ../Mosaiq

# Build the workspace
cd ../Mosaiq
pnpm install
pnpm -r build

# Add as file: deps to LaunchAI
cd ../LaunchAI
pnpm add file:../Mosaiq/packages/persona-schema file:../Mosaiq/packages/sdk

# Install Mosaiq's bundled Chromium (separate from LaunchAI's playwright@1.49
# because Mosaiq pins playwright-core@1.59)
pnpm --filter @mosaiq/sdk exec playwright install chromium
```

> If you prefer not to add a file: dep yet, leave `BROWSER_RUNTIME=local`.
> The Mosaiq runtime fails fast at runtime with a clear error if the SDK
> is missing — typecheck / build are not affected.

### 3.2 Enable in env

Add to `.env.local`:

```dotenv
BROWSER_RUNTIME=mosaiq
MOSAIQ_RUNTIME_ROOT=./.mosaiq-profiles
MOSAIQ_DEFAULT_TEMPLATE=win11-chrome-us
MOSAIQ_DEFAULT_TIMEZONE=America/New_York
```

Available templates (from `@mosaiq/persona-schema/templates`):

| Template | OS | Browser | Suggested timezone |
|---|---|---|---|
| `win11-chrome-us` | Windows 11 | Chrome | America/New_York |
| `win10-chrome-us` | Windows 10 | Chrome | America/Chicago |
| `macos-sonoma-chrome-us` | macOS Sonoma | Chrome | America/Los_Angeles |
| `ubuntu-2204-chrome-us` | Ubuntu 22.04 | Chrome | America/New_York |

> ⚠ `MOSAIQ_DEFAULT_TIMEZONE` must match your proxy's egress IP timezone.
> Mismatch (e.g. US IP + Asia/Shanghai TZ) gets caught by every fingerprint
> consistency check on the market.

### 3.3 Verify

```bash
# 1. Start worker with Mosaiq runtime
BROWSER_RUNTIME=mosaiq pnpm dev:worker

# 2. Connect a Reddit test account
BROWSER_RUNTIME=mosaiq pnpm connect:account -- --platform=reddit --user=test-user-1
# Mosaiq Chromium opens (headed). Manually log in. On post-login URL,
# LaunchAI captures storageState into browser_sessions.

# 3. Run browser-check to dump the fingerprint
BROWSER_RUNTIME=mosaiq pnpm browser:check -- --user=test-user-1 --platform=reddit
# Expected: UA-CH headers, navigator.platform=Win32 (matches Win11 template),
# WebGL UNMASKED_VENDOR=Google Inc. (ANGLE D3D11)

# 4. (Optional) Run Mosaiq's Detection Lab on the persona
cd ../Mosaiq
node packages/cli/bin/mosaiq.js detection-lab run launchai-<hash>-reddit
# Inspect the weighted hits report. CreepJS bold-fail = expected
# (WebGL UNMASKED uniqueness is a known data-bound ceiling).
```

The persona id is derived from `(userId, platform)` via SHA-1 hash — see
`personaIdFor()` in `src/lib/browser/runtime-mosaiq.ts`. You can list
generated personas:

```bash
cd ../Mosaiq && node packages/cli/bin/mosaiq.js persona list | grep ^launchai-
```

## 4. Semantics

### 4.1 Persona-per-account mapping

LaunchAI's `(userId, platform)` ⇄ Mosaiq's `personaId`:

```ts
personaIdFor('user_abc123', 'reddit')
// → 'launchai-a9e5b1d3c8f2-reddit'
```

Hash is stable: the same `(userId, platform)` always produces the same
persona id, so re-running `connect:account` against the same account
reuses the persona (and its on-disk user-data-dir).

### 4.2 On-disk layout

```
LaunchAI/
├── .browser-profiles/        # gitignored; used by `local` runtime
│   └── <userId>/<platform>/  # Chromium user-data-dir per account
├── .mosaiq-profiles/         # gitignored; used by `mosaiq` runtime
│   └── profiles/
│       └── <personaId>/
│           ├── persona.json  # Mosaiq metadata
│           └── user-data-dir/  # Chromium user-data-dir per persona
```

Both layouts persist IndexedDB + service workers (the cookies-only
storageState approach was abandoned for the reasons in
`docs/BROWSER_AUTONOMY.md` §4.1 — Mosaiq follows the same design).

### 4.3 ToS alignment

LaunchAI's anti-auto-registration policy (`docs/BROWSER_AUTONOMY.md` §2)
is unchanged. Mosaiq does **not** automate signup flows or bypass
SMS/CAPTCHA — it only makes long-running operation of user-owned accounts
indistinguishable from a real human's Chromium. Onboarding still requires
the user to manually log in once, in a headed session.

### 4.4 What changes for existing code

**Nothing.** All callers of `getBrowserRuntime()` keep working. The
returned `ManagedBrowser` exposes the same `page` / `saveStorageState` /
`close` surface; only the underlying engine changes.

The `runtime` column in `browser_sessions` accepts a new value
(`'mosaiq'`) but no migration is required — the column is `text` without
an enum constraint. The `BrowserRuntimeKind` TypeScript type is widened
to `'local' | 'browserbase' | 'mosaiq'`.

## 5. Trade-offs

| Choice | Why | Cost |
|---|---|---|
| Dynamic `import()` of `@mosaiq/sdk` | Missing dep doesn't break LaunchAI typecheck / build for users who never enable mosaiq | One extra import error path; first `startSession()` call is ~10ms slower |
| Hash userId into persona id | Clerk userIds are ~28 chars; Mosaiq's persona id regex caps at 64 chars and disallows underscores | `personaIdFor()` is non-reversible, so debugging requires a userId→hash lookup |
| Mosaiq ships its own playwright-core@1.59 | Mosaiq's anti-detection injection is tightly coupled to that version's `addScriptToEvaluateOnNewDocument` API | Two Playwright copies in node_modules (~150MB extra), but they're isolated and don't conflict |
| Persistent user-data-dir (Mosaiq default) | Cookies-only storageState loses IndexedDB / Service Worker → many platforms (Indie Hackers / X) become silently logged out | Single-writer per persona; can't run two sessions against the same Reddit account concurrently (mirrors LaunchAI's local runtime contract) |
| Run mosaiq runtime in-process | Lowest latency, simplest deploy | LaunchAI process holds Chromium handles; restart kills sessions. Acceptable for L1 because BullMQ retries are configured. |

## 6. Known limitations (L1)

| Limitation | Mitigation |
|---|---|
| No proxy support yet | L3. Add `account_state.proxy` + wire into Mosaiq persona's `proxy` field. |
| No humanize on click/type | L2. Mosaiq's humanize is exposed via `session.humanize()` but L1 only swaps fingerprint, not behavior. Cloudflare-strict platforms may still flag at the active-behavior layer. |
| No automatic Detection Lab scheduling | L3. Add BullMQ repeat job to run `runDetection()` per persona weekly, auto-pause on regression. |
| TLS (JA3 / JA4) fingerprint not yet spoofed | This is Mosaiq's roadmap v0.16 (TLS proxy layer). Document as known boundary. |
| Two Chromium binaries on disk (playwright@1.49 + playwright-core@1.59) | Accept; ~250MB total. Long-term: align LaunchAI to playwright@1.59. |

## 7. Roadmap

See `docs/AUTOMATION_ROADMAP.md` for the broader plan. The Mosaiq-specific
follow-up tickets are:

- [ ] **L2-1**: `humanize-adapter.ts` + ToolOverrides in `tools.ts` /
  `agent.ts` so `click` / `type` go through `session.humanize()`.
- [ ] **L3-1**: `proxy_pool` table + per-persona proxy assignment.
- [ ] **L3-2**: `detection-lab-sweep` BullMQ worker; auto-paused
  transition on weighted-hits regression.
- [ ] **Maintenance**: Once Mosaiq publishes to npm / GitHub Packages,
  swap the `file:` deps for versioned ones.
