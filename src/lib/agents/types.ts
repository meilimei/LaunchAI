/**
 * Core agent contracts.
 *
 * Every agent in LaunchAI conforms to the same shape:
 *   - Receives a typed Context (job + previous agent outputs)
 *   - Emits decision logs as it runs (for the dashboard timeline)
 *   - Returns a typed Output (also persisted to its own table)
 *
 * The Orchestrator wires agents together as a deterministic DAG.
 * "Autonomous decisions" inside an agent (e.g., API vs DOM crawl)
 * are encoded as code branches with LLM in the loop for ambiguous cases —
 * NOT free-roaming ReAct loops.
 */
import type { Job } from '@/lib/db/schema'

// ---------- Common ----------

export type AgentName =
  | 'crawler'
  | 'analyst'
  | 'competitor'
  | 'writer'
  | 'critic'
  | 'scheduler'
  | 'orchestrator'

export type Channel =
  | 'cws_listing'
  | 'product_hunt'
  | 'reddit'
  | 'hacker_news'
  | 'twitter'
  | 'indie_hackers'

export type ProductType =
  | 'chrome_extension'
  | 'saas'
  | 'cli_tool'
  | 'vscode_extension'
  | 'unknown'

/**
 * Emitted from inside an agent step. The orchestrator persists this to
 * `decision_logs` and pushes it via Redis pubsub for the SSE stream.
 */
export interface DecisionEvent {
  jobId: string
  agent: AgentName
  step: string
  inputSummary?: string
  outputSummary?: string
  reasoning?: string
  rawInput?: unknown
  rawOutput?: unknown
  model?: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  durationMs?: number
  status?: 'ok' | 'error' | 'skipped'
  error?: string
}

/**
 * The orchestrator passes this to every agent. Agents pull what they need.
 * As pipeline progresses, more fields are populated.
 */
export interface AgentContext {
  job: Job
  emit: (event: Omit<DecisionEvent, 'jobId'>) => Promise<void>
  // Cross-agent outputs (set by orchestrator as steps complete)
  crawl?: CrawlerOutput
  analysis?: AnalystOutput
  competitors?: CompetitorOutput
  assets?: WriterOutput[]
  critic?: CriticOutput
}

// ---------- Crawler ----------

export interface CrawlerOutput {
  productType: ProductType
  product: {
    url: string
    sourceType: 'cws' | 'github' | 'web'
    raw: ProductRaw
  }
  competitors: Array<{
    url: string
    name?: string
    raw?: ProductRaw
  }>
}

export interface ProductRaw {
  name?: string
  tagline?: string
  description?: string
  longDescription?: string
  category?: string
  installs?: number
  rating?: number
  ratingCount?: number
  screenshots?: string[]
  reviews?: Array<{ rating: number; text: string; date?: string }>
  rawHtml?: string
  meta?: Record<string, string>
}

// ---------- Analyst ----------

export interface AnalystOutput {
  features: Array<{
    name: string
    benefit: string
    evidenceQuote?: string
  }>
  painPoints: string[]
  keywords: string[]
  tone: {
    formality: number // 1-5, validated at runtime
    technicality: number // 1-5, validated at runtime
    suggestedTone: string
  }
  reviewsSummary?: string
}

// ---------- Competitor ----------

export interface CompetitorOutput {
  competitors: Array<{
    url: string
    name: string
    listingShape: {
      titleLength: number
      shortDescLength: number
      keywords: string[]
      rating?: number
    }
  }>
  differentiationHints: string[]
}

// ---------- Writer ----------

export interface WriterVersion {
  version: 'a' | 'b' | 'c'
  styleLabel: string // 'technical' | 'story' | 'pain-point'
  content: ChannelContent
}

export type ChannelContent =
  | CwsListingContent
  | ProductHuntContent
  | RedditContent
  | HackerNewsContent
  | TwitterContent
  | IndieHackersContent

export interface CwsListingContent {
  channel: 'cws_listing'
  title: string
  shortDescription: string
  detailedDescription: string
  promoTile: string
  screenshotCaptions: string[]
}

export interface ProductHuntContent {
  channel: 'product_hunt'
  tagline: string
  description: string
  firstComment: string
  makerComment: string
  topics: string[]
}

export interface RedditContent {
  channel: 'reddit'
  subreddit: string
  title: string
  body: string
  selfPromoNote: string
}

export interface HackerNewsContent {
  channel: 'hacker_news'
  title: string // "Show HN: ..."
  body: string
  commentStrategy: string
}

export interface TwitterContent {
  channel: 'twitter'
  hookTweet: string
  thread: string[]
  retweetCopy: string
}

export interface IndieHackersContent {
  channel: 'indie_hackers'
  title: string
  body: string
  milestone: string
}

export interface WriterOutput {
  channel: Channel
  versions: WriterVersion[]
}

// ---------- Critic ----------

export interface CriticScore {
  toneB2D: number // 0-10
  specificity: number
  compliance: number
  hookStrength: number
  total: number
}

export interface CriticOutput {
  byChannel: Record<
    Channel,
    {
      recommendedVersion: 'a' | 'b' | 'c'
      scores: Record<'a' | 'b' | 'c', CriticScore>
      reasoning: string
    }
  >
}

// ---------- Scheduler ----------

export interface SchedulerOutput {
  schedule: Array<{
    channel: Channel
    scheduledAt: string // ISO
    notes: string
  }>
}

// ---------- Agent interface ----------

export interface Agent<TOutput> {
  name: AgentName
  run(ctx: AgentContext): Promise<TOutput>
}
