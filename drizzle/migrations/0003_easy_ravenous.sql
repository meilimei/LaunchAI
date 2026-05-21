CREATE TABLE "platform_selector_hints" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"url_pattern" text NOT NULL,
	"tool" text NOT NULL,
	"selector" text NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "selector_hints_platform_pattern_idx" ON "platform_selector_hints" USING btree ("platform","url_pattern");--> statement-breakpoint
CREATE UNIQUE INDEX "selector_hints_unique" ON "platform_selector_hints" USING btree ("platform","url_pattern","tool","selector");