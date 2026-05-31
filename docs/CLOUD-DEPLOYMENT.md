# LaunchAI 云端自主运行 — 部署 Runbook

> 目标：让 LaunchAI 脱离本地、在云端 24/7 自主运行。本文是**可执行的逐步手册**,
> 覆盖 LaunchAI 自身 + 它依赖的 Mosaiq Cloud 浏览器后端。
>
> 配套:`docs/TECH.md` §9(部署拓扑)、`docs/AUTOMATION_ROADMAP.md`(自主执行分阶段)、
> `Mosaiq:docs/PHASE-11.2-FLY-DEPLOY.md`(Mosaiq Cloud 上 Fly 的完整 runbook)。

---

## 0. 拓扑总览

```
┌──────────────── 用户浏览器 ────────────────┐
│  Dashboard (URL 输入 / SSE 实时时间轴 / 资产)   │
└───────────────────┬───────────────────────┘
                    │ HTTPS
                    ▼
┌──────────── Vercel (Next.js web + API) ────────────┐   scale-to-zero
│  /api/launch  /api/campaigns  /api/launch/[id]/events │   serverless
└───────┬───────────────────────────────┬──────────────┘
        │ enqueue (BullMQ)               │ Inngest events (Phase 3)
        ▼                                ▼
┌─ Upstash Redis ─┐            ┌──────── Inngest (Phase 3) ────────┐
│ queue + pubsub  │            │ cron / fan-out / 每账号并发控制     │
└───────┬─────────┘            └──────────────┬────────────────────┘
        │ 消费                                 │ HTTP /api/inngest
        ▼                                      ▼
┌──────────────── Fly.io: launchai-worker (常驻) ────────────────┐
│  src/worker/index.ts — BullMQ 消费 + (Phase 3) warmup runOneTick │
│  · 发布资产流水线: Crawler(fetch) → Analyst → Writer → Critic     │
│  · 养号/发帖: 通过 BROWSER_RUNTIME=mosaiq 驱动远端浏览器          │
└───────┬──────────────────────────────────┬──────────────────────┘
        │ SQL                               │ REST + CDP-over-wss
        ▼                                   ▼
┌─ Supabase Postgres ─┐      ┌──────── Mosaiq Cloud (Fly.io) ────────┐
│ jobs/assets/campaigns│      │ mosaiq-cloud-runtime (控制平面)        │
│ /browser_sessions... │      │ mosaiq-browser-pod (per-session 浏览器) │
└──────────────────────┘      │ + (Phase 3) 每账号 sticky 住宅代理      │
                              └────────────────────────────────────────┘
```

**核心边界(摘自 `AUTOMATION_ROADMAP.md`)**:UI/API 是 serverless(Vercel);
**执行(浏览器)必须在有稳定出口 IP 的常驻机器上**。所以 Web 与 Worker 分开部署。

---

## 1. 账号 / 前置条件(需要你本人操作,我无法替你登录或计费)

| 依赖 | 用途 | 状态 |
|---|---|---|
| **Vercel** 账号 | LaunchAI Web/API | 需新建 + `vercel login` |
| **Fly.io** 账号(`ifly@163.com`) | LaunchAI worker + Mosaiq Cloud | ✅ 已有(Mosaiq 在用) |
| **Supabase** 项目(ap-southeast-2) | Postgres | ✅ `.env.local` 已配 |
| **Upstash** Redis | 队列/pubsub | ✅ 已配 |
| **DeepSeek** API key | 所有 LLM agent | ✅ 已配 |
| **npm** 账号(或私有 registry) | 发布 `@mosaiq/cloud-sdk`(见 Phase 0) | 需注册/登录 |
| **Inngest** 账号(Phase 3) | 自主调度 | 需新建 |
| **住宅代理**(Phase 3,Bright Data/Oxylabs) | 每账号 sticky 出口 IP | 需采购($) |

工具:`flyctl`、`vercel` CLI、`pnpm@9.15`、Node ≥ 20.10。

---

## Phase 0 — 解除云端构建的硬阻塞:发布 Mosaiq SDK 到 npm

**为什么必须先做**:`src/lib/browser/runtime-mosaiq.ts` 和多个 `scripts/*.ts` 静态
`import ... from '@mosaiq/cloud-sdk'`。本地它是指向 `D:\projects\Mosaiq\packages\*`
的 pnpm 软链(junction),**不在 `pnpm-lock.yaml` 里**。Vercel `next build` 会对整个
源码树做类型检查,clean 环境没有这个软链 → **构建直接失败**。

### 0.1 在 Mosaiq 仓库发布两个包

按 `Mosaiq:docs/RELEASING.md` 执行(需 npm 账号 + `@mosaiq` scope):

```bash
cd D:/projects/Mosaiq
pnpm --filter @mosaiq/persona-schema build
pnpm --filter @mosaiq/cloud-sdk build
npm login                                   # 一次性
pnpm --filter @mosaiq/persona-schema publish --access public
pnpm --filter @mosaiq/cloud-sdk publish --access public
```

### 0.2 在 LaunchAI 用 registry 版本替换软链

```bash
cd D:/projects/LaunchAI
pnpm remove @mosaiq/cloud-sdk @mosaiq/persona-schema 2>$null   # 清掉 link(若存在)
pnpm add @mosaiq/cloud-sdk @mosaiq/persona-schema              # 装 npm 正式版
pnpm typecheck                                                 # 应仍然 0 error
git add package.json pnpm-lock.yaml ; git commit -m "deps: consume @mosaiq SDK from npm"
```

> **不想现在发 npm 的临时替代**:`pnpm --filter @mosaiq/cloud-sdk pack` 生成 tgz,
> 拷进 LaunchAI 仓库,`package.json` 用 `"@mosaiq/cloud-sdk": "file:./vendor/mosaiq-cloud-sdk-0.11.0.tgz"`。
> 能让构建过,但每次 Mosaiq 更新都要重新 pack,长期建议还是走 npm。

---

## Phase 1 — 部署 LaunchAI(发布资产流水线先 24/7 跑起来)

这一阶段**不依赖 Mosaiq、不碰养号**:`URL → 营销资产` 全流程只用 `fetch` 抓取 + DeepSeek。
完成后产品即可在云端按需自主运行(用户提交 URL → worker 跑 → dashboard 出结果)。

### 1.1 推送数据库 schema 到 Supabase(一次性)

```bash
cd D:/projects/LaunchAI
pnpm db:push          # 走 DIRECT_URL(5432);pooler 6543 不支持 DDL
pnpm diag:db          # 期望结尾: [diag-db] OK — campaign runtime schema is fully applied.
```

### 1.2 部署 Web 到 Vercel

```bash
cd D:/projects/LaunchAI
npm i -g vercel ; vercel login
vercel link                       # 关联/新建 Vercel 项目
# 在 Vercel Dashboard → Settings → Environment Variables 填入 §3「Web」那张表
vercel --prod                     # 首次生产部署
```

要点:
- Build command 默认 `next build`,Output `.next` — Vercel 自动识别 Next 15,无需改。
- API 路由 `runtime = 'nodejs'`、SSE 路由 `dynamic = 'force-dynamic'` 已就绪,Vercel Node runtime 直接支持流式 SSE。
- **Web 不跑 worker**:Vercel serverless 函数不能常驻,BullMQ 消费在 Fly worker(下一步)。

### 1.3 部署 Worker 到 Fly.io

制品已就绪:`Dockerfile`、`.dockerignore`、`fly.toml`(本次新增)。

```bash
cd D:/projects/LaunchAI
flyctl auth login ; flyctl auth whoami      # 期望 ifly@163.com
flyctl apps create launchai-worker --org personal

# 灌 secrets(见 §3「Worker」表;Phase 1 只需 DB/Redis/DeepSeek)
flyctl secrets set `
  DATABASE_URL="postgresql://...pooler.supabase.com:6543/postgres" `
  DIRECT_URL="postgresql://...pooler.supabase.com:5432/postgres" `
  REDIS_URL="rediss://default:...@...upstash.io:6379" `
  DEEPSEEK_API_KEY="sk-..." `
  --app launchai-worker

flyctl deploy -c fly.toml                    # 国内网络若卡 docker.io,加 --remote-only
flyctl logs -a launchai-worker               # 期望: [worker] LaunchAI worker started, waiting for jobs...
```

### 1.4 端到端验证

打开 Vercel 域名 `/launch`,粘一个 Chrome Web Store URL,观察 dashboard 实时时间轴跑完
`Crawler → Analyst → Writer → Critic → Scheduler` 并产出资产。`flyctl logs` 里应看到
`[worker] ✅ launch ok in N.Ns, cost $0.xxxx`。

✅ **出阶段**:产品发布资产流水线在云端自主可用。

---

## Phase 2 — 部署 Mosaiq Cloud 并接通(打开浏览器路径)

LaunchAI 的养号/发帖需要远端浏览器后端 = Mosaiq Cloud。

### 2.1 部署 Mosaiq Cloud 到 Fly

完整步骤见 **`Mosaiq:docs/PHASE-11.2-FLY-DEPLOY.md`**(已 prod 验证)。一句话版:

```bash
cd D:/projects/Mosaiq
flyctl apps create mosaiq-browser-pod --org personal
flyctl apps create mosaiq-cloud-runtime --org personal
flyctl deploy -c fly.browser-pod.toml --dockerfile apps/browser-pod/Dockerfile --build-only --push
flyctl volumes create cloud_runtime_data --app mosaiq-cloud-runtime --region iad --size 1
flyctl tokens create deploy --org personal --expiry 8760h > ~/.fly-machines-token
flyctl secrets set FLY_API_TOKEN=$(cat ~/.fly-machines-token) FLY_POD_APP_NAME=mosaiq-browser-pod METRICS_TOKEN=$(openssl rand -hex 32) --app mosaiq-cloud-runtime
flyctl deploy -c fly.cloud-runtime.toml --dockerfile apps/cloud-runtime/Dockerfile
curl https://mosaiq-cloud-runtime.fly.dev/v1/health     # manager:"fly", db.ok:true
```

### 2.2 建 LaunchAI 的 prod API key + 注册 persona

```bash
# 在 Mosaiq Cloud 上为 proj_launchai 建 key(plaintext 只显示一次,存好)
flyctl ssh console -a mosaiq-cloud-runtime -C 'node dist/admin/create-api-key.js proj_launchai'
# → msq_sk_live_...

# 注册一个默认 persona(一次性)
cd D:/projects/Mosaiq
$env:MOSAIQ_API_URL="https://mosaiq-cloud-runtime.fly.dev"
$env:MOSAIQ_API_KEY="msq_sk_live_..."
$env:MOSAIQ_PROJECT_ID="proj_launchai"
node packages/cloud-sdk/scripts/register-persona.mjs    # → win11-chrome-us-default
```

### 2.3 把 worker 的 Mosaiq secrets 指向 Fly

```bash
flyctl secrets set `
  MOSAIQ_API_URL="https://mosaiq-cloud-runtime.fly.dev" `
  MOSAIQ_API_KEY="msq_sk_live_..." `
  MOSAIQ_PROJECT_ID="proj_launchai" `
  MOSAIQ_DEFAULT_PERSONA_ID="win11-chrome-us-default" `
  --app launchai-worker
# fly.toml 已设 BROWSER_RUNTIME=mosaiq;secrets set 会自动重启 worker
```

### 2.4 单账号浏览器 smoke

```bash
# 本机(指向 Fly)先跑一遍,确认整条 CDP 链路通:
cd D:/projects/LaunchAI
# .env.local 的 MOSAIQ_API_URL 临时改成 https://mosaiq-cloud-runtime.fly.dev
pnpm dev:mosaiq-smoke      # 期望: 🎉 LaunchAI ↔ Mosaiq Cloud smoke PASSED
```

✅ **出阶段**:LaunchAI 能通过 Mosaiq Cloud 驱动远端带反指纹的浏览器会话。

---

## Phase 3 — 真·自主养号(调度 + 执行 + 代理)

> 现状(`AUTOMATION_ROADMAP.md`):养号执行还在 **Stage 0(手动 CLI)**——没有
> scheduler/cron/loop。**部署本身不会让它自动养号**,要先补这部分代码。下面是
> roadmap 选定的 Stage 1→2 路径。这些是**待我落地的代码任务**(见 git todo)。

### 3.1 抽 `runOneTick` 纯函数(Stage 1,零风险重构)

把 `scripts/dev-warmup.ts` 的核心(load state → plan → execute step[0] → 持久化 →
trajectory)抽成 `src/lib/warmup/run-one-tick.ts`:
- 入参显式传(`{ userId, platform, context, execute, headful, ... }`),**不读 `process.env`**;
- `dev-warmup.ts` 改成调它的薄 CLI 包装;
- trajectory 落盘走接口(本地 `tmp/`,worker 走 S3-compatible)。
roadmap §5 明确「先做这个,解锁后续全部执行形态」。

### 3.2 接入 Inngest(Stage 2 调度)

- `pnpm add inngest`;新增 `src/inngest/{client,functions}.ts` + `src/app/api/inngest/route.ts`;
- 一个 `scheduled`(如每 15 min)函数:遍历可执行的 `(userId, platform)`,算 `next_eligible_at`,对到点的调 `runOneTick`;
- `concurrency.key = "${userId}:${platform}"` 保证每账号同时只有一个动作在飞;
- Web 加「暂停/恢复养号」按钮 → 发 Inngest 事件。
- Inngest handler 既可跑在 Vercel(`/api/inngest`)也可由 Fly worker 执行实际浏览器动作。

### 3.3 每账号 sticky 住宅代理(Stage 3)

- 采购 Bright Data / Oxylabs sticky residential;每平台账号一个 `session_id` 存 `browser_sessions.proxyRef`;
- 接入点:Mosaiq `createSession` 的 per-session 代理(优先,IP 归属在 Mosaiq pod 侧)或 worker 出口;
- 配合 Mosaiq `keepAlive:true` + `userMetadata.stickyKey`(见 `docs/MOSAIQ-INTEGRATION-REQUESTS.md` Request 1),让 Reddit 等账号常驻同一 device fingerprint + cookie/IndexedDB。
- 多账号:数据模型已是 `(userId, platform)`,扩到 `(userId, platform, accountLabel)` 是局部迁移。

✅ **出阶段**:LaunchAI 按计划自主对各平台账号做 grooming + 发帖。

---

## 3. 环境变量参考

### Web(Vercel)

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Supabase transaction pooler(6543) |
| `DIRECT_URL` | ⬜ | Supabase 直连(5432),迁移用 |
| `REDIS_URL` | ✅ | Upstash `rediss://` |
| `DEEPSEEK_API_KEY` | ✅ | LLM |
| `NEXT_PUBLIC_APP_URL` | ✅ | Vercel 生产域名 |
| `NEXT_PUBLIC_CLERK_*` / `CLERK_SECRET_KEY` | ⬜ | 当前未启用鉴权(dev-user),v1.1 再填 |

### Worker(Fly `launchai-worker`)

| Secret | 阶段 | 说明 |
|---|---|---|
| `DATABASE_URL` / `DIRECT_URL` | P1 | 同上 |
| `REDIS_URL` | P1 | 同上 |
| `DEEPSEEK_API_KEY` | P1 | LLM |
| `BROWSER_RUNTIME=mosaiq` | P2 | 已在 `fly.toml [env]` |
| `MOSAIQ_API_URL` | P2 | `https://mosaiq-cloud-runtime.fly.dev` |
| `MOSAIQ_API_KEY` | P2 | `msq_sk_live_...`(Mosaiq 侧建) |
| `MOSAIQ_PROJECT_ID=proj_launchai` | P2 | |
| `MOSAIQ_DEFAULT_PERSONA_ID` | P2 | `win11-chrome-us-default` |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | P3 | Inngest |
| 代理凭据 | P3 | Bright Data/Oxylabs |

---

## 4. 成本量级(月)

| 项 | 量级 | 备注 |
|---|---|---|
| Vercel | $0(Hobby) | Web/API scale-to-zero |
| Fly `launchai-worker` | ~$3-5 | shared-cpu-1x / 512MB 常驻 |
| Mosaiq cloud-runtime | ~$3-5 | 控制平面常驻(iad) |
| Mosaiq browser-pod | 按用量 | per-session microVM,跑完即销毁 |
| Supabase / Upstash | $0(Free) | dev 量级 |
| DeepSeek | ~$0.11-0.22/次发布资产 | 见 `TECH.md` §7 |
| Inngest(P3) | $0(Free 50k runs/mo) | |
| 住宅代理(P3) | $$ | >10 账号时的主要成本,按 GB/IP 计费 |

---

## 5. 当前进度

- ✅ 制品就绪:`Dockerfile` / `.dockerignore` / `fly.toml`(LaunchAI worker)
- ✅ Mosaiq Cloud Fly 制品 + runbook 就绪(`Mosaiq:docs/PHASE-11.2-FLY-DEPLOY.md`,prod 验证过)
- ✅ **Mosaiq Cloud 已部署**: `https://mosaiq-cloud-runtime.fly.dev/v1/health` → `manager:"fly"`, db ok
- ✅ **LaunchAI worker 已部署**: `launchai-worker` Fly app, secrets 已配, 2026-05-31 修复 tsx 缺失后重新 deploy
- ⬜ **Phase 0(可选)**:发布 `@mosaiq/*` 到 npm — 当前用 `vendor/*.tgz` file 依赖, Vercel 构建可用同样方式
- ⬜ **Phase 1 Web**:Vercel 部署(需 `vercel login` + Dashboard 灌 env)
- ⬜ **Phase 3 代码**:`runOneTick` 重构 + Inngest + 代理(待落地)

### 部署踩坑备忘

1. **Worker 崩溃 `tsx: not found`**: Dockerfile 里 `NODE_ENV=production` 会让 `pnpm install` 跳过 devDependencies。修复: `pnpm install --prod=false`, 且把 `tsx` 移到 `dependencies`。
2. **`flyctl deploy` 长时间无输出**: 默认走 Depot builder, 国内常卡在 `Waiting for depot builder...`。加 `--depot=false` 走 Fly 原生 remote builder, ~3 min 有进度。
3. **Worker 更新后 machine 仍是 stopped**: 若之前 crash 触达 max restart count, deploy 后需 `flyctl machine start <id> -a launchai-worker`, 或 destroy 后 `fly scale count worker=1` 重建。
