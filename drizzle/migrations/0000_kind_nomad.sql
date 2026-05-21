CREATE TYPE "public"."action_status" AS ENUM('draft', 'pending_approval', 'approved', 'scheduled', 'executing', 'completed', 'failed', 'blocked', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."agent" AS ENUM('crawler', 'analyst', 'competitor', 'writer', 'critic', 'scheduler', 'orchestrator');--> statement-breakpoint
CREATE TYPE "public"."autopilot_level" AS ENUM('assisted', 'supervised', 'full_autopilot');--> statement-breakpoint
CREATE TYPE "public"."campaign_phase" AS ENUM('research', 'launch', 'amplify', 'compound', 'optimize');--> statement-breakpoint
CREATE TYPE "public"."campaign_phase_status" AS ENUM('pending', 'active', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('cws_listing', 'product_hunt', 'reddit', 'hacker_news', 'twitter', 'indie_hackers');--> statement-breakpoint
CREATE TYPE "public"."feedback_action" AS ENUM('adopted', 'modified', 'rejected', 'regenerated');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'crawling', 'analyzing', 'generating', 'critiquing', 'scheduling', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'solo', 'pro', 'lifetime');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('chrome_extension', 'saas', 'cli_tool', 'vscode_extension', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."risk_policy" AS ENUM('conservative', 'balanced', 'aggressive');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'completed', 'failed', 'canceled', 'skipped');--> statement-breakpoint
CREATE TABLE "actions" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"task_id" text,
	"platform" text NOT NULL,
	"type" text NOT NULL,
	"status" "action_status" DEFAULT 'draft' NOT NULL,
	"risk_level" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"external_id" text,
	"external_url" text,
	"error" text,
	"scheduled_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"features" jsonb NOT NULL,
	"pain_points" jsonb NOT NULL,
	"keywords" jsonb NOT NULL,
	"tone" jsonb NOT NULL,
	"reviews_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"action_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text DEFAULT 'system' NOT NULL,
	"decided_by" text,
	"reason" text,
	"policy_snapshot" jsonb,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"channel" "channel" NOT NULL,
	"version" text NOT NULL,
	"style_label" text,
	"content" jsonb NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"critic_score" numeric(5, 2),
	"critic_reasoning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_phases" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"phase" "campaign_phase" NOT NULL,
	"status" "campaign_phase_status" DEFAULT 'pending' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_url" text NOT NULL,
	"product_type" "product_type" DEFAULT 'unknown' NOT NULL,
	"status" "campaign_status" DEFAULT 'active' NOT NULL,
	"goal" text DEFAULT '90_day_product_led_growth' NOT NULL,
	"autopilot_level" "autopilot_level" DEFAULT 'full_autopilot' NOT NULL,
	"risk_policy" "risk_policy" DEFAULT 'balanced' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"competitor_url" text NOT NULL,
	"name" text,
	"listing" jsonb,
	"differentiation_hints" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"agent" "agent" NOT NULL,
	"step" text NOT NULL,
	"input_summary" text,
	"output_summary" text,
	"reasoning" text,
	"raw_input" jsonb,
	"raw_output" jsonb,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(10, 6),
	"duration_ms" integer,
	"status" text DEFAULT 'ok' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"user_id" text NOT NULL,
	"action" "feedback_action" NOT NULL,
	"edited_content" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"account_id" text,
	"account_name" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"scopes" jsonb,
	"token_ref" text,
	"metadata" jsonb,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"campaign_id" text,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"input_url" text NOT NULL,
	"product_type" "product_type" DEFAULT 'unknown' NOT NULL,
	"total_cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"campaign_id" text,
	"job_id" text,
	"source_type" text NOT NULL,
	"source_id" text,
	"scope" text DEFAULT 'campaign' NOT NULL,
	"channel" text,
	"task_type" text,
	"content" text NOT NULL,
	"summary" text,
	"confidence" numeric(4, 3) DEFAULT '0.500' NOT NULL,
	"embedding" jsonb,
	"metadata" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"platform_post_id" text,
	"platform" text NOT NULL,
	"metric_type" text DEFAULT 'post' NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"upvotes" integer,
	"comments" integer,
	"conversions" integer,
	"raw" jsonb,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"action_id" text,
	"job_id" text,
	"platform" text NOT NULL,
	"external_id" text,
	"external_url" text,
	"title" text,
	"body" text,
	"metadata" jsonb,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_scrapes" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text NOT NULL,
	"raw_html" text,
	"parsed_json" jsonb,
	"scraped_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"channel" "channel" NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"reminded_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"job_id" text,
	"type" text NOT NULL,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"stripe_customer_id" text,
	"monthly_jobs_used" integer DEFAULT 0 NOT NULL,
	"monthly_jobs_reset_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_phases" ADD CONSTRAINT "campaign_phases_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_logs" ADD CONSTRAINT "decision_logs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_snapshots" ADD CONSTRAINT "metrics_snapshots_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_snapshots" ADD CONSTRAINT "metrics_snapshots_platform_post_id_platform_posts_id_fk" FOREIGN KEY ("platform_post_id") REFERENCES "public"."platform_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_posts" ADD CONSTRAINT "platform_posts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_posts" ADD CONSTRAINT "platform_posts_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_posts" ADD CONSTRAINT "platform_posts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_scrapes" ADD CONSTRAINT "raw_scrapes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actions_campaign_status_idx" ON "actions" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "actions_task_idx" ON "actions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "actions_platform_idx" ON "actions" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "approvals_campaign_status_idx" ON "approvals" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "approvals_action_idx" ON "approvals" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "assets_job_channel_idx" ON "assets" USING btree ("job_id","channel");--> statement-breakpoint
CREATE INDEX "campaign_phases_campaign_idx" ON "campaign_phases" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_phases_status_idx" ON "campaign_phases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_user_created_idx" ON "campaigns" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "competitors_job_idx" ON "competitors" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "decision_logs_job_order_idx" ON "decision_logs" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_user_idx" ON "feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "feedback_asset_idx" ON "feedback" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "integrations_user_platform_idx" ON "integrations" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "jobs_user_created_idx" ON "jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_campaign_idx" ON "jobs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "memories_user_scope_idx" ON "memories" USING btree ("user_id","scope");--> statement-breakpoint
CREATE INDEX "memories_campaign_idx" ON "memories" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "memories_channel_task_idx" ON "memories" USING btree ("channel","task_type");--> statement-breakpoint
CREATE INDEX "metrics_campaign_captured_idx" ON "metrics_snapshots" USING btree ("campaign_id","captured_at");--> statement-breakpoint
CREATE INDEX "metrics_platform_post_idx" ON "metrics_snapshots" USING btree ("platform_post_id");--> statement-breakpoint
CREATE INDEX "platform_posts_campaign_idx" ON "platform_posts" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "platform_posts_platform_idx" ON "platform_posts" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "platform_posts_external_idx" ON "platform_posts" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "raw_scrapes_job_idx" ON "raw_scrapes" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "schedules_job_idx" ON "schedules" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "schedules_upcoming_idx" ON "schedules" USING btree ("scheduled_at") WHERE reminded_at IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_campaign_status_idx" ON "tasks" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "tasks_scheduled_idx" ON "tasks" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "tasks_job_idx" ON "tasks" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");