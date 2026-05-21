-- ============================================================
-- LaunchAI raw SQL schema reference.
-- Source of truth is `src/lib/db/schema.ts` (Drizzle).
-- This file is for human reference and emergency manual fixes.
--
-- Generate migrations:  pnpm db:generate
-- Push to dev DB:       pnpm db:push
-- ============================================================

-- ---------- Enums ----------

CREATE TYPE plan AS ENUM ('free', 'solo', 'pro', 'lifetime');

CREATE TYPE job_status AS ENUM (
  'queued', 'crawling', 'analyzing', 'generating',
  'critiquing', 'scheduling', 'completed', 'failed'
);

CREATE TYPE product_type AS ENUM (
  'chrome_extension', 'saas', 'cli_tool', 'vscode_extension', 'unknown'
);

CREATE TYPE channel AS ENUM (
  'cws_listing', 'product_hunt', 'reddit', 'hacker_news', 'twitter', 'indie_hackers'
);

CREATE TYPE agent AS ENUM (
  'crawler', 'analyst', 'competitor', 'writer', 'critic', 'scheduler', 'orchestrator'
);

CREATE TYPE feedback_action AS ENUM (
  'adopted', 'modified', 'rejected', 'regenerated'
);

-- ---------- users ----------

CREATE TABLE users (
  id                    text PRIMARY KEY,
  email                 text NOT NULL,
  plan                  plan NOT NULL DEFAULT 'free',
  stripe_customer_id    text,
  monthly_jobs_used     integer NOT NULL DEFAULT 0,
  monthly_jobs_reset_at timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_idx ON users (email);

-- ---------- jobs ----------

CREATE TABLE jobs (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          job_status NOT NULL DEFAULT 'queued',
  input_url       text NOT NULL,
  product_type    product_type NOT NULL DEFAULT 'unknown',
  total_cost_usd  numeric(10, 4) NOT NULL DEFAULT 0,
  error           text,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_user_created_idx ON jobs (user_id, created_at DESC);
CREATE INDEX jobs_status_idx ON jobs (status);

-- ---------- raw_scrapes ----------

CREATE TABLE raw_scrapes (
  id           text PRIMARY KEY,
  job_id       text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_type  text NOT NULL,
  source_url   text NOT NULL,
  raw_html     text,
  parsed_json  jsonb,
  scraped_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX raw_scrapes_job_idx ON raw_scrapes (job_id);

-- ---------- analyses ----------

CREATE TABLE analyses (
  id              text PRIMARY KEY,
  job_id          text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  features        jsonb NOT NULL,
  pain_points     jsonb NOT NULL,
  keywords        jsonb NOT NULL,
  tone            jsonb NOT NULL,
  reviews_summary text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- competitors ----------

CREATE TABLE competitors (
  id                    text PRIMARY KEY,
  job_id                text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  competitor_url        text NOT NULL,
  name                  text,
  listing               jsonb,
  differentiation_hints jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX competitors_job_idx ON competitors (job_id);

-- ---------- assets ----------

CREATE TABLE assets (
  id                text PRIMARY KEY,
  job_id            text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  channel           channel NOT NULL,
  version           text NOT NULL,
  style_label       text,
  content           jsonb NOT NULL,
  is_recommended    boolean NOT NULL DEFAULT false,
  critic_score      numeric(5, 2),
  critic_reasoning  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_job_channel_idx ON assets (job_id, channel);

-- ---------- decision_logs ----------

CREATE TABLE decision_logs (
  id              text PRIMARY KEY,
  job_id          text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  agent           agent NOT NULL,
  step            text NOT NULL,
  input_summary   text,
  output_summary  text,
  reasoning       text,
  raw_input       jsonb,
  raw_output      jsonb,
  model           text,
  tokens_in       integer,
  tokens_out      integer,
  cost_usd        numeric(10, 6),
  duration_ms     integer,
  status          text NOT NULL DEFAULT 'ok',
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decision_logs_job_order_idx ON decision_logs (job_id, created_at);

-- ---------- feedback ----------

CREATE TABLE feedback (
  id              text PRIMARY KEY,
  asset_id        text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action          feedback_action NOT NULL,
  edited_content  text,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_user_idx ON feedback (user_id);
CREATE INDEX feedback_asset_idx ON feedback (asset_id);

-- ---------- schedules ----------

CREATE TABLE schedules (
  id            text PRIMARY KEY,
  job_id        text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  channel       channel NOT NULL,
  scheduled_at  timestamptz NOT NULL,
  reminded_at   timestamptz,
  published_at  timestamptz,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_job_idx ON schedules (job_id);
CREATE INDEX schedules_upcoming_idx ON schedules (scheduled_at) WHERE reminded_at IS NULL;
