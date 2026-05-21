/**
 * Drizzle ORM schema for LaunchAI.
 *
 * Mirrors `db/schema.sql` but is the source of truth.
 * Run `pnpm db:generate` to produce migrations.
 *
 * Design notes:
 * - All ids are short nanoid strings (URL-safe, 21 chars).
 * - All timestamps default to NOW() and are timezone-aware.
 * - jsonb is used liberally because agent outputs are nested, evolving structures.
 * - decision_logs is the single source of truth for the dashboard timeline.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// ---------- Enums ----------

export const planEnum = pgEnum('plan', ['free', 'solo', 'pro', 'lifetime'])

export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'crawling',
  'analyzing',
  'generating',
  'critiquing',
  'scheduling',
  'completed',
  'failed',
])

export const productTypeEnum = pgEnum('product_type', [
  'chrome_extension',
  'saas',
  'cli_tool',
  'vscode_extension',
  'unknown',
])

export const channelEnum = pgEnum('channel', [
  'cws_listing',
  'product_hunt',
  'reddit',
  'hacker_news',
  'twitter',
  'indie_hackers',
])

export const agentEnum = pgEnum('agent', [
  'crawler',
  'analyst',
  'competitor',
  'writer',
  'critic',
  'scheduler',
  'orchestrator',
])

export const feedbackActionEnum = pgEnum('feedback_action', [
  'adopted',
  'modified',
  'rejected',
  'regenerated',
])

export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'canceled',
])

export const campaignPhaseEnum = pgEnum('campaign_phase', [
  'research',
  'launch',
  'amplify',
  'compound',
  'optimize',
])

export const campaignPhaseStatusEnum = pgEnum('campaign_phase_status', [
  'pending',
  'active',
  'completed',
  'skipped',
])

export const autopilotLevelEnum = pgEnum('autopilot_level', [
  'assisted',
  'supervised',
  'full_autopilot',
])

export const riskPolicyEnum = pgEnum('risk_policy', [
  'conservative',
  'balanced',
  'aggressive',
])

export const taskStatusEnum = pgEnum('task_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
  'skipped',
])

export const actionStatusEnum = pgEnum('action_status', [
  'draft',
  'pending_approval',
  'approved',
  'scheduled',
  'executing',
  'completed',
  'failed',
  'blocked',
  'canceled',
])

// ---------- Tables ----------

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(), // Clerk user id
    email: text('email').notNull(),
    plan: planEnum('plan').notNull().default('free'),
    stripeCustomerId: text('stripe_customer_id'),
    monthlyJobsUsed: integer('monthly_jobs_used').notNull().default(0),
    monthlyJobsResetAt: timestamp('monthly_jobs_reset_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
  }),
)

export const campaigns = pgTable(
  'campaigns',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productUrl: text('product_url').notNull(),
    productType: productTypeEnum('product_type').notNull().default('unknown'),
    status: campaignStatusEnum('status').notNull().default('active'),
    goal: text('goal').notNull().default('90_day_product_led_growth'),
    autopilotLevel: autopilotLevelEnum('autopilot_level').notNull().default('full_autopilot'),
    riskPolicy: riskPolicyEnum('risk_policy').notNull().default('balanced'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('campaigns_user_created_idx').on(t.userId, t.createdAt),
    statusIdx: index('campaigns_status_idx').on(t.status),
  }),
)

export const campaignPhases = pgTable(
  'campaign_phases',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    phase: campaignPhaseEnum('phase').notNull(),
    status: campaignPhaseStatusEnum('status').notNull().default('pending'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignIdx: index('campaign_phases_campaign_idx').on(t.campaignId),
    statusIdx: index('campaign_phases_status_idx').on(t.status),
  }),
)

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    status: jobStatusEnum('status').notNull().default('queued'),
    inputUrl: text('input_url').notNull(),
    productType: productTypeEnum('product_type').notNull().default('unknown'),
    totalCostUsd: numeric('total_cost_usd', { precision: 10, scale: 4 })
      .notNull()
      .default('0'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('jobs_user_created_idx').on(t.userId, t.createdAt),
    campaignIdx: index('jobs_campaign_idx').on(t.campaignId),
    statusIdx: index('jobs_status_idx').on(t.status),
  }),
)

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    status: taskStatusEnum('status').notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    input: jsonb('input'),
    output: jsonb('output'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignStatusIdx: index('tasks_campaign_status_idx').on(t.campaignId, t.status),
    scheduledIdx: index('tasks_scheduled_idx').on(t.scheduledAt),
    jobIdx: index('tasks_job_idx').on(t.jobId),
  }),
)

export const actions = pgTable(
  'actions',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    platform: text('platform').notNull(),
    type: text('type').notNull(),
    status: actionStatusEnum('status').notNull().default('draft'),
    riskLevel: integer('risk_level').notNull().default(0),
    payload: jsonb('payload'),
    result: jsonb('result'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    error: text('error'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignStatusIdx: index('actions_campaign_status_idx').on(t.campaignId, t.status),
    taskIdx: index('actions_task_idx').on(t.taskId),
    platformIdx: index('actions_platform_idx').on(t.platform),
  }),
)

export const rawScrapes = pgTable(
  'raw_scrapes',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(), // 'cws' | 'github' | 'web' | 'reddit' | 'ph_api'
    sourceUrl: text('source_url').notNull(),
    rawHtml: text('raw_html'),
    parsedJson: jsonb('parsed_json'),
    scrapedAt: timestamp('scraped_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobIdx: index('raw_scrapes_job_idx').on(t.jobId),
  }),
)

export const analyses = pgTable('analyses', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  features: jsonb('features').notNull(), // [{name, benefit, evidence_quote}]
  painPoints: jsonb('pain_points').notNull(), // string[]
  keywords: jsonb('keywords').notNull(), // string[]
  tone: jsonb('tone').notNull(), // {formality, technicality, suggested_tone}
  reviewsSummary: text('reviews_summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const competitors = pgTable(
  'competitors',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    competitorUrl: text('competitor_url').notNull(),
    name: text('name'),
    listing: jsonb('listing'), // parsed listing structure
    differentiationHints: jsonb('differentiation_hints'), // string[]
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobIdx: index('competitors_job_idx').on(t.jobId),
  }),
)

export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    channel: channelEnum('channel').notNull(),
    version: text('version').notNull(), // 'a' | 'b' | 'c'
    styleLabel: text('style_label'), // 'technical' | 'story' | 'pain-point'
    content: jsonb('content').notNull(), // channel-specific schema
    isRecommended: boolean('is_recommended').notNull().default(false),
    criticScore: numeric('critic_score', { precision: 5, scale: 2 }),
    criticReasoning: text('critic_reasoning'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobChannelIdx: index('assets_job_channel_idx').on(t.jobId, t.channel),
  }),
)

export const decisionLogs = pgTable(
  'decision_logs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    agent: agentEnum('agent').notNull(),
    step: text('step').notNull(),
    inputSummary: text('input_summary'),
    outputSummary: text('output_summary'),
    reasoning: text('reasoning'),
    rawInput: jsonb('raw_input'),
    rawOutput: jsonb('raw_output'),
    model: text('model'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    durationMs: integer('duration_ms'),
    status: text('status').notNull().default('ok'), // 'ok' | 'error' | 'skipped'
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobOrderIdx: index('decision_logs_job_order_idx').on(t.jobId, t.createdAt),
  }),
)

export const feedback = pgTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    action: feedbackActionEnum('action').notNull(),
    editedContent: text('edited_content'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('feedback_user_idx').on(t.userId),
    assetIdx: index('feedback_asset_idx').on(t.assetId),
  }),
)

export const schedules = pgTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    channel: channelEnum('channel').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobIdx: index('schedules_job_idx').on(t.jobId),
    upcomingIdx: index('schedules_upcoming_idx').on(t.scheduledAt).where(sql`reminded_at IS NULL`),
  }),
)

export const integrations = pgTable(
  'integrations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    accountId: text('account_id'),
    accountName: text('account_name'),
    status: text('status').notNull().default('connected'),
    scopes: jsonb('scopes'),
    tokenRef: text('token_ref'),
    metadata: jsonb('metadata'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userPlatformIdx: index('integrations_user_platform_idx').on(t.userId, t.platform),
  }),
)

export const browserSessions = pgTable(
  'browser_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    accountLabel: text('account_label'),
    status: text('status').notNull().default('connected'),
    storageState: jsonb('storage_state'),
    runtime: text('runtime').notNull().default('local'),
    fingerprint: jsonb('fingerprint'),
    /**
     * Per-account grooming state — see docs/ACCOUNT_GROOMING.md §3 and the
     * AccountState type in src/lib/platforms/types.ts. Drives the warm-up
     * planner and cooldown enforcement.
     */
    accountState: jsonb('account_state'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userPlatformIdx: index('browser_sessions_user_platform_idx').on(t.userId, t.platform),
    statusIdx: index('browser_sessions_status_idx').on(t.status),
  }),
)

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    actionId: text('action_id').references(() => actions.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    requestedBy: text('requested_by').notNull().default('system'),
    decidedBy: text('decided_by'),
    reason: text('reason'),
    policySnapshot: jsonb('policy_snapshot'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignStatusIdx: index('approvals_campaign_status_idx').on(t.campaignId, t.status),
    actionIdx: index('approvals_action_idx').on(t.actionId),
  }),
)

export const platformPosts = pgTable(
  'platform_posts',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    actionId: text('action_id').references(() => actions.id, { onDelete: 'set null' }),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    platform: text('platform').notNull(),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    title: text('title'),
    body: text('body'),
    metadata: jsonb('metadata'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignIdx: index('platform_posts_campaign_idx').on(t.campaignId),
    platformIdx: index('platform_posts_platform_idx').on(t.platform),
    externalIdx: index('platform_posts_external_idx').on(t.platform, t.externalId),
  }),
)

export const metricsSnapshots = pgTable(
  'metrics_snapshots',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    platformPostId: text('platform_post_id').references(() => platformPosts.id, {
      onDelete: 'set null',
    }),
    platform: text('platform').notNull(),
    metricType: text('metric_type').notNull().default('post'),
    impressions: integer('impressions'),
    clicks: integer('clicks'),
    upvotes: integer('upvotes'),
    comments: integer('comments'),
    conversions: integer('conversions'),
    raw: jsonb('raw'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignCapturedIdx: index('metrics_campaign_captured_idx').on(t.campaignId, t.capturedAt),
    postIdx: index('metrics_platform_post_idx').on(t.platformPostId),
  }),
)

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    scope: text('scope').notNull().default('campaign'),
    channel: text('channel'),
    taskType: text('task_type'),
    content: text('content').notNull(),
    summary: text('summary'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull().default('0.500'),
    embedding: jsonb('embedding'),
    metadata: jsonb('metadata'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userScopeIdx: index('memories_user_scope_idx').on(t.userId, t.scope),
    campaignIdx: index('memories_campaign_idx').on(t.campaignId),
    channelTaskIdx: index('memories_channel_task_idx').on(t.channel, t.taskType),
  }),
)

/**
 * Platform-level selector telemetry. Each row records that on a given URL
 * pattern, calling a given tool with a given selector either worked
 * (returned non-trivial content / changed page state) or didn't.
 *
 * Why platform-level (not per-user): selectors depend on the SITE's HTML,
 * not on the user. A selector that works for one user's Reddit account
 * works for all of them. Aggregating across users gives faster learning.
 *
 * URL patterns normalize away dynamic path segments — e.g. /r/ChatGPT and
 * /r/privacy both map to /r/*. See `urlToPattern` in lib/browser/url-pattern.
 *
 * The agent reads the top-N successful selectors for the current page's
 * URL pattern at navigate-time and surfaces them as hints in the step prompt.
 */
export const platformSelectorHints = pgTable(
  'platform_selector_hints',
  {
    id: text('id').primaryKey(),
    platform: text('platform').notNull(),
    /** Normalized URL pattern, e.g. "old.reddit.com/r/*\/about/rules". */
    urlPattern: text('url_pattern').notNull(),
    /** Tool name from ToolCallSchema: 'extract_text' | 'click' | 'type' | 'wait_for' | 'read_main_content'. */
    tool: text('tool').notNull(),
    /**
     * Selector argument as the agent supplied it. For tools without a
     * selector (read_main_content, body extract) we store the literal
     * '__none__' so the unique index still works.
     */
    selector: text('selector').notNull(),
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Lookup path: given (platform, urlPattern), get top selectors.
    platformPatternIdx: index('selector_hints_platform_pattern_idx').on(
      t.platform,
      t.urlPattern,
    ),
    // Used for upserts: each (platform, urlPattern, tool, selector) is a unique row.
    uniqueRow: uniqueIndex('selector_hints_unique').on(
      t.platform,
      t.urlPattern,
      t.tool,
      t.selector,
    ),
  }),
)

// ---------- Type exports ----------

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Campaign = typeof campaigns.$inferSelect
export type NewCampaign = typeof campaigns.$inferInsert
export type CampaignPhase = typeof campaignPhases.$inferSelect
export type NewCampaignPhase = typeof campaignPhases.$inferInsert
export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
export type Action = typeof actions.$inferSelect
export type NewAction = typeof actions.$inferInsert
export type Asset = typeof assets.$inferSelect
export type NewAsset = typeof assets.$inferInsert
export type DecisionLog = typeof decisionLogs.$inferSelect
export type NewDecisionLog = typeof decisionLogs.$inferInsert
export type Analysis = typeof analyses.$inferSelect
export type NewAnalysis = typeof analyses.$inferInsert
export type Competitor = typeof competitors.$inferSelect
export type RawScrape = typeof rawScrapes.$inferSelect
export type Feedback = typeof feedback.$inferSelect
export type Schedule = typeof schedules.$inferSelect
export type Integration = typeof integrations.$inferSelect
export type BrowserSession = typeof browserSessions.$inferSelect
export type NewBrowserSession = typeof browserSessions.$inferInsert
export type Approval = typeof approvals.$inferSelect
export type PlatformPost = typeof platformPosts.$inferSelect
export type MetricsSnapshot = typeof metricsSnapshots.$inferSelect
export type Memory = typeof memories.$inferSelect
