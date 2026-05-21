# LaunchAI 技术架构文档

> **版本**:v0.1(planning)
> **配套**:`PRD.md` / `COMPETITIVE_ANALYSIS.md`

---

## 0. 设计哲学

### 0.1 核心原则

> **底层确定性 pipeline,上层 agent 化呈现。**

- 真实的 LLM 自主决策路由(开放式 ReAct loop)在 2026 年生产环境仍然不稳定 / 慢 / 贵
- LaunchAI 把"自主感"放在 **UX 层**(可视化 + 解释 + 可干预),而把可靠性放在**确定性 pipeline**
- 每个 Agent 是一个"有 LLM 在做决策的子任务",**不是**一个开放循环

### 0.2 三类决策

| 决策类型 | 实现方式 | 例子 |
|---|---|---|
| **路由决策**(API vs DOM) | if-else + LLM 兜底 | URL 是 CWS → 用公开数据;否则 Playwright |
| **抽取决策**(从原始数据提取卖点) | 单次 LLM call,structured output | 从产品页 HTML 抽取 5 个卖点 |
| **创作决策**(写文案) | LLM call,结构化 prompt + few-shot | 写 PH tagline 3 版本 |

只有第二、三类用 LLM,第一类用代码。这样既稳又便宜。

---

## 1. 高层架构

```
┌────────────────────────────────────────────────────┐
│  Frontend (Next.js + React + shadcn/ui)            │
│  - URL input                                        │
│  - Real-time agent dashboard (SSE)                 │
│  - Asset preview & copy                            │
└────────────────────────────────────────────────────┘
                      │ REST + SSE
                      ▼
┌────────────────────────────────────────────────────┐
│  API Gateway (Next.js Route Handlers / Hono)       │
│  - Auth (Clerk)                                    │
│  - Rate limit                                      │
│  - Job submit / SSE stream                         │
└────────────────────────────────────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────────────┐
│  Job Queue (BullMQ on Redis)                       │
│  - Async job dispatch                              │
│  - Retry / backoff                                 │
└────────────────────────────────────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────────────┐
│  Orchestrator (Node worker)                        │
│  └─ Pipeline: Crawler → Analyst → Writer → Critic  │
│     ├─ Each step writes progress to Redis pubsub   │
│     ├─ Each step persists IO to Postgres           │
│     └─ Failures retry with backoff                 │
└────────────────────────────────────────────────────┘
       │              │              │             │
       ▼              ▼              ▼             ▼
   Crawler        Analyst        Writer        Critic
   - Playwright   - DeepSeek     - DeepSeek    - DeepSeek
   - chrome-stats   V4-Pro         V4-Pro        V4-Pro
   - Reddit API   - structured   - 3 versions  - rubric scoring
   - PH API         extract                      - explain
                                     per channel
                      │
                      ▼
┌────────────────────────────────────────────────────┐
│  Storage                                           │
│  - Postgres (Supabase): users / jobs / assets /   │
│    feedback / decisions                            │
│  - Redis: queue + pubsub + cache                  │
│  - S3-compatible: raw scrapes / generated images  │
└────────────────────────────────────────────────────┘
```

---

## 2. 技术栈选型

### 2.1 前端

| 选项 | 选择 | 理由 |
|---|---|---|
| Framework | **Next.js 15(App Router)** | SSR + Route Handlers + Vercel 部署一体化 |
| UI lib | **shadcn/ui + Tailwind** | 模块化、易定制 |
| Icons | **Lucide React** | 与 shadcn 配套 |
| State | **Zustand + TanStack Query** | 轻量、SSR 友好 |
| Realtime | **EventSource (SSE)** | 比 WebSocket 简单,够用 |

### 2.2 后端

| 模块 | 选择 | 理由 |
|---|---|---|
| API | **Next.js Route Handlers**(主)+ **separate Node worker** | 简单部署 + 长任务隔离 |
| 长任务 worker | **Node.js + BullMQ** | 与前端同语言、生态成熟 |
| 队列 | **Redis(Upstash)** | 串通队列 + pubsub + 缓存 |
| 数据库 | **Postgres(Supabase)** | 关系数据 + RLS + 实时订阅 |
| 对象存储 | **R2 / S3** | 抓取截图 / 生成图片 |
| Auth | **Clerk** | OAuth + 用户管理 + 免运维 |
| 支付 | **Stripe** | 标准 SaaS 选择 |
| 监控 | **Sentry + PostHog** | 错误 + 产品分析 |

### 2.3 AI 层

| 用途 | 模型选择 | 理由 |
|---|---|---|
| **结构化抽取**(产品信息、竞品 listing 解析) | **DeepSeek V4 Pro**（fallback: gpt-4o-mini） | 1M 上下文 + thinking mode，input $0.145/M，JSON 输出稳定 |
| **创作型生成**(launch 文案) | **DeepSeek V4 Pro**（fallback: Claude Sonnet 4.5） | 与 Sonnet 同级质量、output $3.48/M（Sonnet 是 $15/M） |
| **Critic 评分** | **DeepSeek V4 Pro** + rubric | 同一模型打分避免跨厂商偏差 |
| **图片生成** | **DALL-E 3** 或 **Imagen 3** | 仅 v2 用 |
| **嵌入**(可选，v2+) | **text-embedding-3-small** | 用于 prompt corpus 检索 |

默认模型为 **deepseek-v4-pro**：thinking mode 默认开启、reasoning_effort=high，
1M token 上下文。走 OpenAI-兼容端点 `https://api.deepseek.com`。
注意：`temperature` / `top_p` 在 thinking 模式下被安全忽略（不报错）。
对照规则见 `src/lib/llm/config.ts`。

### 2.4 抓取层

| 数据源 | 工具 | 备用 |
|---|---|---|
| Chrome Web Store | 官方页面 + chrome-stats.com 公开数据 | Playwright |
| Product Hunt | PH GraphQL API | Playwright |
| Reddit | Reddit API(snoowrap) | 公开页面 |
| Hacker News | Algolia HN API | — |
| 通用网页 | **Playwright + AI extract** | Cheerio(简单页面) |

抓取调度:**Browserless / Browserbase** SaaS,避免自建 Playwright 集群。

---

## 3. 多 Agent 设计

### 3.1 Agent 总览

| Agent | 职责 | 模型 | 输入 | 输出 |
|---|---|---|---|---|
| **Crawler** | 抓取产品 + 竞品原始数据 | 不用 LLM(只在结构判断时用) | URL | 原始 HTML / JSON |
| **Analyst** | 提取卖点 / 痛点 / 关键词 / 用户评论摘要 | DeepSeek V4 Pro（JSON） | Crawler 输出 | `{features, pain_points, keywords, tone, reviews_summary}` |
| **Competitor** | 解析竞品 listing,生成对比表 | DeepSeek V4 Pro（JSON） | 竞品原始数据 | `{competitors[], differentiation_hints[]}` |
| **Writer**(per channel) | 生成 N 版本文案 | DeepSeek V4 Pro | Analyst + Competitor 输出 + channel spec | `{version_a, version_b, version_c}` |
| **Critic** | 评分 + 推荐 + 解释 | DeepSeek V4 Pro | Writer 输出 | `{recommended_version, scores, reasoning}` |
| **Scheduler** | 计算最佳发布时间 | 不用 LLM(查表) | 渠道 + 用户时区 | 7 天日历 |
| **Orchestrator** | 编排执行顺序 / 重试 / 进度上报 | 不用 LLM | 用户请求 | 协调所有 agent |

### 3.2 Agent 协作流程

```
1. User: POST /api/launch { url }
2. Orchestrator: createJob(url) → 入队
3. Worker:
   a. Crawler.run(url)
      → 探测 URL 类型
      → 调用对应数据源
      → 同时抓取产品 + Top 10 竞品
      → 写入 raw_scrapes 表
      → publish progress: "已抓取 11 个页面"
   b. Analyst.run(crawler_output)
      → LLM call: 提取 features / pain_points / keywords / tone
      → 写入 analysis 表
      → publish progress: "已识别 5 个核心卖点"
   c. Competitor.run(crawler_output.competitors)
      → LLM call: 解析每个竞品 listing
      → 生成差异化建议
      → publish progress: "已分析 10 个竞品"
   d. For each channel in [CWS, PH, Reddit, HN, X, IH]:
       Writer.run(channel, analysis, competitors)
         → LLM call: 生成 3 个版本
         → 写入 assets 表
         → publish progress: "已生成 PH 版本 1/3..."
   e. Critic.run(all_assets)
      → LLM call: 对每个版本打分(rubric)
      → 推荐最优组合
      → 生成"为什么推荐"解释
      → publish progress: "完成评分,推荐版本 B"
   f. Scheduler.run(channels, user_timezone)
      → 查表:每个平台最佳发布时间
      → 生成 7 天日历
4. Worker → Job done → publish "complete"
5. Frontend SSE: 接收每条 progress + 完成事件 → 渲染 dashboard
```

### 3.3 决策可视化的数据契约

每个 Agent 的执行写入 `decision_log` 表:

```typescript
interface DecisionLog {
  id: string
  job_id: string
  agent: 'crawler' | 'analyst' | 'competitor' | 'writer' | 'critic' | 'scheduler'
  step: string                    // e.g. "extract_features"
  input_summary: string           // 给用户看的简化输入
  output_summary: string          // 给用户看的简化输出
  reasoning: string | null        // LLM 的 reasoning(若是 LLM 步骤)
  raw_input: jsonb                // 完整输入(可点开看)
  raw_output: jsonb               // 完整输出
  model: string | null            // 用了哪个模型
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  duration_ms: number
  created_at: timestamptz
}
```

前端按 `job_id` 订阅 → 实时渲染时间轴 → 用户点开任一步看详情。

---

## 4. 数据模型

### 4.1 核心表

```sql
-- 用户
users (id, email, plan, stripe_customer_id, created_at)

-- 一次完整生成
jobs (
  id, user_id, status, input_url, product_type,
  total_cost_usd, started_at, completed_at, error
)

-- 抓取的原始数据
raw_scrapes (
  id, job_id, source_type, source_url, raw_html,
  parsed_json, scraped_at
)

-- Analyst 输出
analyses (
  id, job_id, features jsonb, pain_points jsonb,
  keywords jsonb, tone jsonb, reviews_summary text
)

-- 竞品分析
competitors (
  id, job_id, competitor_url, name, listing jsonb,
  differentiation_hints jsonb
)

-- 生成的资产(每渠道每版本一行)
assets (
  id, job_id, channel, version, content jsonb,
  is_recommended bool, critic_score numeric, critic_reasoning text
)

-- 决策日志(可视化用)
decision_logs (
  id, job_id, agent, step, input_summary, output_summary,
  reasoning, raw_input jsonb, raw_output jsonb,
  model, tokens_in, tokens_out, cost_usd, duration_ms, created_at
)

-- 用户反馈(v3 闭环用)
feedback (
  id, asset_id, user_id, action,  -- adopted / modified / rejected / regenerated
  edited_content text, reason text, created_at
)

-- 发布日历
schedules (
  id, job_id, channel, scheduled_at, reminded_at, published_at
)
```

### 4.2 索引重点

- `jobs(user_id, created_at desc)` — 用户列表
- `decision_logs(job_id, created_at)` — 时间轴
- `assets(job_id, channel)` — 资产分组
- `feedback(user_id, action)` — v3 学习用

---

## 5. 抓取策略详解

### 5.1 Chrome Web Store 数据获取

CWS 没有官方公开 API。可用数据源:

1. **CWS 详情页 HTML**:Playwright 渲染后取 JSON-LD + `meta` tags
2. **chrome-stats.com**:第三方聚合数据,有部分公开 API(免费有限)
3. **类似扩展挖掘**:CWS 详情页的 "类似扩展" + 关键词搜索结果

### 5.2 通用 URL 抓取

```ts
async function smartCrawl(url: string) {
  const type = detectUrlType(url)        // cws / github / saas / unknown

  if (type === 'cws')   return crawlCWS(url)
  if (type === 'github') return crawlGithubReadme(url)

  // 通用 SaaS 落地页
  const html = await playwright.render(url)
  const extracted = await llm.extract(html, schema)  // DeepSeek V4 Pro JSON mode
  return extracted
}
```

### 5.3 抓取限流与重试

- 每 IP / 每域名:最多 1 req/s
- 失败重试:3 次指数 backoff
- 缓存:同 URL 24 小时内复用
- 用户体感:抓取失败时 Crawler 输出"该数据源不可用,降级使用 X",**对用户透明**

---

## 6. Prompt 工程

### 6.1 Analyst Agent prompt 结构

```
System:
你是 B2D 营销分析师。从产品页提取信息,严格输出 JSON。

User input:
{product_html_truncated}
{user_reviews_truncated}

Output schema:
{
  features: [{name, benefit, evidence_quote}, ...],   // 最多 5 个
  pain_points: [string, ...],                          // 用户评论中提到的
  keywords: [string, ...],                             // SEO / ASO 关键词
  tone: {
    formality: 1-5,
    technicality: 1-5,
    suggested_tone: string
  },
  reviews_summary: string  // 100 字以内
}

Constraints:
- 所有 evidence_quote 必须是原文
- 不编造 features
- pain_points 只来自用户评论或低星评分
```

### 6.2 Writer Agent(以 Reddit 为例)

```
System:
你是为开发者社区写帖的资深 maker。
目标 subreddit: {subreddit}
该 subreddit 调性: {subreddit_tone_brief}
自我推广合规规则: {subreddit_rules}

Product context:
{analysis_json}
{competitors_json}

Task:
写 3 个版本的帖子(标题 + 正文)。

Constraints:
- 不许使用 markety 词汇:{blacklist: "revolutionary", "game-changer", ...}
- 必须提及具体技术细节
- 标题 ≤ 300 字符
- 正文 200-500 字
- 每版本风格区分明显:技术深度型 / 故事型 / 痛点型

Output JSON schema: {versions: [{title, body, style_label}, ...]}
```

### 6.3 Critic Agent rubric

```
对每个 asset 评分(0-10):
- tone_b2d: 开发者友好度(避免 markety)
- specificity: 具体性(技术细节、避免空话)
- compliance: 平台合规(自我推广分寸、长度)
- hook_strength: 钩子强度(开头吸引力)

总分 = (tone_b2d * 0.35 + specificity * 0.25 + compliance * 0.20 + hook_strength * 0.20) * 10

推荐版本 = 总分最高的那个
解释 = "推荐版本 B,因为它在 tone_b2d 上得 9 分(版本 A 只有 6 分,使用了 'revolutionary' 等词)..."
```

---

## 7. 成本估算

### 7.1 单次完整运行的 LLM 成本

按全渠道 V4-Pro 算（full list price，忽略 75% 促销和 cache hit）：

| 步骤 | 模型 | tokens（in/out） | 成本 |
|---|---|---|---|
| Analyst | DeepSeek V4 Pro | 8000 / 1500 | $0.0064 |
| Competitor（× 10） | DeepSeek V4 Pro | 4000×10 / 800×10 | $0.034 |
| Writer × 6 渠道 × 3 版本 | DeepSeek V4 Pro | 3000×18 / 800×18 | $0.058 |
| Critic | DeepSeek V4 Pro | 8000 / 2000 | $0.0081 |
| **小计 LLM** | | | **~$0.11** |
| Playwright（Browserbase） | | 11 页 × $0.01 | $0.11 |
| **总计** | | | **~$0.22** |

thinking mode 占 output tokens 一半左右，实际 LLM 成本可能滑到 $0.15。
上一版（GPT-4o-mini + Sonnet 路径）估算 ~$0.34，迁到 V4-Pro 后每次运行节省
~$0.12，带到 7.3 单位经济一起算：Solo 套餐每月成本从 ∼$1.35 降到 ∼$0.66。

### 7.2 模型路由优化

- 用户开 Free 套餐 → Writer 降级到 **deepseek-v4-flash**（output $0.28/M，比 Pro 便宜 ~12×）→ 总成本 ~$0.04
- 命中缓存（同 URL 24h 内） → 跳过 Crawler / Analyst → 成本 ~$0.15
- DeepSeek context cache 默认开启，input cache hit $0.0145/M（成本 10%）→ 同一 system prompt 重跑近乎免费
- Critic 启用半缓存（同 prompt + 同 asset 类型）→ 节省 ~$0.005

### 7.3 单位经济

| 套餐 | 价格 | 月含次数 | 月最大成本 | 毛利 |
|---|---|---|---|---|
| Free | $0 | 1 | $0.10 | -$0.10(获客成本) |
| Solo | $19 | 3 | $1.35 | $17.65(93%) |
| Pro | $49 | 10 | $4.50 | $44.50(91%) |

---

## 8. 风险与控制

| 风险 | 影响 | 控制措施 |
|---|---|---|
| **LLM 超额预算** | 成本失控 | 用户级 hard limit + 模型路由 + Free 限速 |
| **Playwright 抓取失败** | 部分用户拿不到结果 | 多源数据 + 降级策略 + 对用户透明 |
| **Reddit API 限流** | 帖子草稿无法基于真实 subreddit 数据 | 缓存 subreddit 元数据 24h + fallback 到预制 corpus |
| **Critic 推荐质量差** | 用户不信任 | rubric 量化 + 解释卡片 + 用户可一键切换版本 |
| **B2D 调性失败** | 核心壁垒崩塌 | 早期 100% 人工审核 + 持续维护黑词表 + few-shot corpus |
| **数据隐私** | 用户隐私担忧 | 不用 OpenAI 训练通道(API 默认) + 隐私政策声明 |
| **Stripe 退款** | 现金流压力 | 7 天免责退款 + 首次结果不满意自动重跑 |

---

## 9. 部署与运维

### 9.1 部署拓扑

```
Vercel(Next.js)        ← 前端 + API gateway
Railway / Fly.io        ← Node worker(常驻)
Upstash Redis           ← queue + pubsub + cache
Supabase                ← Postgres + Auth backup
Browserbase             ← Playwright 集群
Cloudflare R2           ← 对象存储
```

### 9.2 环境

- `dev`:本地 docker-compose(Redis + Postgres + worker)
- `staging`:Railway preview
- `prod`:Vercel + Railway prod

### 9.3 关键监控

- LLM 调用成功率 / 平均延迟 / 平均 tokens / 平均成本(Per-user dashboard via PostHog)
- 抓取成功率(分数据源)
- 每个 Agent 的 P50 / P95 / P99 延迟
- 用户反馈率(adopted / modified / rejected)

---

## 10. v1 实施切分(6 周)

| 周 | 里程碑 | 关键交付 |
|---|---|---|
| 1 | 基础设施 | Next.js 项目骨架 / Clerk 接入 / Postgres schema / BullMQ 跑通 |
| 2 | Crawler + Analyst | Playwright + chrome-stats / Analyst LLM call / 写入数据库 |
| 3 | Writer + Critic | 6 渠道 prompt / 3 版本生成 / Critic rubric |
| 4 | 前端 Dashboard | URL 输入 / SSE 接入 / 决策时间轴 / 资产预览 |
| 5 | 一键复制 + 计划 + Stripe | 深链跳转 / 邮件提醒 / 付费层 |
| 6 | Polish + 邀测 | 错误处理 / 文案打磨 / 10 个种子用户 |

详细任务拆解会在 v1.0 启动时建立 issue tracker。

---

## 11. 待回答的技术细节(实施时再展开)

1. **CWS 详情页 JSON-LD 结构稳定性** — 需要先抓 20 个不同扩展验证
2. **Chrome 同类扩展的发现策略** — keyword search vs 类似推荐 vs 分类爬取
3. **B2D 黑词表初版** — 需要从 r/programming / r/webdev / HN 评论中挖
4. **Reddit subreddit 推荐表** — 至少覆盖 30 个 dev / SaaS / chrome 相关 sub 的元数据
5. **Critic 解释模板** — 怎么写得让用户信服而不是机械式
6. **Playwright 抓取失败时的降级** — 部分降级 vs 完全失败的边界

---

## 附:决策记录

- **为什么不用 LangChain / LangGraph?** 多 agent 编排足够简单(线性 DAG),自己写 50 行 TypeScript 比引入框架更可控。可观测性自己控制更好。
- **为什么不用 Python?** 前后端同语言降低复杂度;LLM SDK 在 TS 生态已经成熟。
- **为什么不用 OpenAI Assistant / Agent SDK?** 成本不可控、不能跨模型、不便迁移。
- **为什么 v1 不用 vector DB?** 不需要语义检索;v2 做用户历史个性化时再引入。
