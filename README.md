# LaunchAI

> **输入产品 URL → AI 自主完成营销全流程 → 输出可执行的 Launch 资产包**

LaunchAI 是一个 **自主化 AI Agent** 营销助理。用户只需粘贴一个产品网址,系统会自主决定如何抓取、分析竞品、生成多渠道营销文案,并以**可视化的方式**展示每一步决策过程。

核心理念:**让 AI 做决策,人类做监督**。

---

## 一句话定位

**v1**:Chrome 扩展开发者的 launch 副驾(独占细分市场)
**v2**:所有 B2D(开发者工具)产品的多渠道发射控制中心
**v3**:闭环优化型营销 agent(launch 后持续监控+迭代)

---

## 用户旅程(v1)

```
输入: https://chromewebstore.google.com/detail/<id>  或任意产品 URL
   ↓
[Crawler Agent] 抓取产品页 + 竞品 Top 10
   ↓
[Analyst Agent] 提取卖点 / 痛点 / 关键词 / 调性
   ↓
[Writer Agent] 多版本文案生成
   ↓
[Critic Agent] 推荐最优组合 + 风险提示
   ↓
输出:
   ├─ Chrome Web Store Listing 优化包(标题/短描/长描/截图文案)
   ├─ Product Hunt Launch 资产(tagline / description / 首日话术)
   ├─ Reddit 帖子草稿 × 3(对应 3 个相关 subreddit)
   ├─ Hacker News Show HN 草稿
   ├─ X / Twitter thread 草稿
   ├─ 发布日历(7 天计划)
   └─ 一键复制 / 深链跳转到对应平台发布页
```

整个过程在一个 **Dashboard** 上实时可视化:用户能看到每个 Agent 在做什么、为什么做、用了哪些数据。

---

## 文档导航

- `docs/COMPETITIVE_ANALYSIS.md` — 竞品调研与差异化切入点
- `docs/PRD.md` — 产品需求文档(范围、用户故事、营收模型)
- `docs/TECH.md` — 技术架构(多 agent 编排、技术栈、成本)

---

## 项目状态

**Phase A / B / C 已完成,准备联调**

- [x] 竞品调研 / 差异化定位 / 架构决策 / PRD / TECH
- [x] **Phase A**:脚手架(配置 + DB schema + Agent 类型 + Worker 骨架)
- [x] **Phase B-1**:Crawler + Analyst + Orchestrator
- [x] **Phase B-2**:Writer + Critic + Scheduler
- [x] **Phase C-1**:URL 提交 API + SSE 实时 dashboard
- [x] **Phase C-2**:Assets 预览 + 一键复制 + 深链跳转 + Schedule UI
- [ ] **联调**:云端 dev 环境跑通真实 URL
- [ ] **v1.1**:Competitor Agent / Clerk auth / 反馈采集 / 邮件提醒
- [ ] **v2**:Stripe 付费 / Playwright fallback

详细 roadmap 见 `docs/PRD.md`。

---

## 本地开发环境

### 前置依赖

- **Node.js** ≥ 20.10
- **pnpm** ≥ 9(`npm i -g pnpm`)
- **Postgres + Redis**:推荐云端方案(下面详述),备选本地容器

### 推荐:云端 dev 模式(Supabase + Upstash)

**为什么默认用云:**

- **生产同栈**:`docs/TECH.md` 锁定生产环境就是 Supabase + Upstash,dev 直接对齐零漂移
- **零安装**:不需要 Docker / WSL2 / 任何虚拟化
- **零成本**:两边都有永久免费额度,v1 dev 阶段 $0/月
- **真实暴露 pooler 行为**:Supabase 用 pgBouncer transaction mode,有些 prepared-statement 坑只有云端能测到

**配置步骤:**

1. **Supabase**(Postgres):

   ```
   注册 https://supabase.com → 新建免费项目 → Settings → Database → Connection string
   - DATABASE_URL  复制 "Transaction pooler"(端口 6543) — app 运行时用
   - DIRECT_URL    复制 "Session pooler" 或 "Direct connection"(端口 5432) — 迁移用
   ```

   ⚠ pooler 6543 **不支持 DDL**,所以 `pnpm db:push` 必须走 5432;两个 URL 都要填,代码已经分流处理。

2. **Upstash**(Redis):

   ```
   注册 https://upstash.com → Create Database → 选就近 region → 复制 "Redis URL"
   注意必须是 rediss:// 开头(TLS),复制后整个粘到 REDIS_URL
   ```

3. **LLM keys**:OpenAI(<https://platform.openai.com/api-keys>)+ Anthropic(<https://console.anthropic.com/>)

**启动:**

```powershell
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
copy .env.example .env.local
# 编辑 .env.local:填 DATABASE_URL / DIRECT_URL / REDIS_URL / OPENAI_API_KEY / ANTHROPIC_API_KEY

# 3. 推送 schema 到 Supabase
pnpm db:push

# 4. 启动 Web + Worker
pnpm dev:all
```

打开 <http://localhost:3000/launch>,粘一个 Chrome Web Store URL,看 dashboard 实时跑。

### 备选:本地容器(Docker / Podman / Rancher)

如果你装得了任何容器运行时:

```powershell
# Docker Desktop
pnpm docker:up

# 或 Podman(脚本里 docker 替换为 podman)
podman compose -f docker-compose.dev.yml up -d
```

然后把 `.env.local` 改回本地 URL:

```env
DATABASE_URL=postgres://launchai:launchai@localhost:5432/launchai
DIRECT_URL=postgres://launchai:launchai@localhost:5432/launchai
REDIS_URL=redis://localhost:6379
```

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 仅启动 Next.js |
| `pnpm dev:worker` | 仅启动 BullMQ worker(watch 模式) |
| `pnpm dev:all` | 同时启动两者 |
| `pnpm dev:enqueue` | 用合成数据手动入队一个 job(不需要 web) |
| `pnpm typecheck` | TypeScript 检查 |
| `pnpm lint` | ESLint(flat config) |
| `pnpm db:generate` | 从 schema.ts 生成迁移文件 |
| `pnpm db:push` | 直接推送 schema(开发用,走 DIRECT_URL) |
| `pnpm db:studio` | 打开 Drizzle Studio |
| `pnpm docker:up` / `:down` / `:logs` | 本地 Postgres + Redis 管理(可选) |

---

## 目录结构

```
LaunchAI/
├── docs/                      # PRD / TECH / 竞品分析
├── db/
│   └── schema.sql             # 原始 SQL 参考(单一真源是 Drizzle schema)
├── src/
│   ├── app/                   # Next.js App Router
│   │   ├── layout.tsx
│   │   ├── page.tsx           # 首页
│   │   └── launch/page.tsx    # URL 输入页(Phase C 接通)
│   ├── lib/
│   │   ├── agents/types.ts    # 多 Agent 类型契约
│   │   ├── db/
│   │   │   ├── schema.ts      # Drizzle schema(单一真源)
│   │   │   └── client.ts
│   │   ├── llm/config.ts      # 模型路由 + 成本估算
│   │   ├── queue/             # BullMQ + Redis pubsub
│   │   ├── env.ts             # 环境变量 zod 校验
│   │   └── utils.ts           # cn 等工具
│   └── worker/index.ts        # BullMQ worker 入口
├── docker-compose.dev.yml     # 本地 Postgres + Redis
├── drizzle.config.ts
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── next.config.ts
```
