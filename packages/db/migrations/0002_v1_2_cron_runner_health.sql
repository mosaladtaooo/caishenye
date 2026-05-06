-- v1.2 FR-024 D5 — cron_runner_health table for VPS-NSSM cron-runner
-- inbound liveness pings (AC-024-3) + Vercel-cron watchdog backstop
-- query (AC-024-4 path 2).
--
-- Constitution section 4: tenant_id NOT NULL with FK to tenants.
--
-- Indexes:
--   - cron_runner_health_pinged_idx          : watchdog scan over MAX(pinged_at)
--   - cron_runner_health_runner_pinged_idx   : self-watch previous-tick lookup

CREATE TABLE "cron_runner_health" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"runner_id" text NOT NULL,
	"pinged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cron_runner_health" ADD CONSTRAINT "cron_runner_health_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cron_runner_health_pinged_idx" ON "cron_runner_health" USING btree ("pinged_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "cron_runner_health_runner_pinged_idx" ON "cron_runner_health" USING btree ("tenant_id","runner_id","pinged_at" DESC NULLS LAST);
