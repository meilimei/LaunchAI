CREATE TABLE "browser_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"account_label" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"storage_state" jsonb,
	"runtime" text DEFAULT 'local' NOT NULL,
	"fingerprint" jsonb,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_sessions_user_platform_idx" ON "browser_sessions" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "browser_sessions_status_idx" ON "browser_sessions" USING btree ("status");