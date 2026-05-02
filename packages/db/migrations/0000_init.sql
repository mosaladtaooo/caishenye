CREATE TYPE "public"."cap_usage_local_kind" AS ENUM('planner_recurring', 'executor_one_off_cap_counted', 'executor_one_off_cap_exempt', 'replan_fire', 'cap_status_cron');--> statement-breakpoint
CREATE TYPE "public"."cap_usage_source" AS ENUM('local_counter', 'anthropic_api');--> statement-breakpoint
CREATE TYPE "public"."channels_restart_reason" AS ENUM('scheduled_idle', 'manual', 'crash');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('open', 'closed', 'cancelled', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('market_buy', 'market_sell', 'limit_buy', 'limit_sell', 'stop_buy', 'stop_sell', 'no_trade', 'rejected_by_risk');--> statement-breakpoint
CREATE TYPE "public"."override_action_type" AS ENUM('close_pair', 'close_all', 'edit_sl_tp', 'pause', 'resume', 'replan');--> statement-breakpoint
CREATE TYPE "public"."pair_schedule_status" AS ENUM('scheduled', 'cancelled', 'fired', 'skipped_no_window');--> statement-breakpoint
CREATE TYPE "public"."routine_fire_kind" AS ENUM('recurring', 'scheduled_one_off', 'fire_api', 'claude_run_bash');--> statement-breakpoint
CREATE TYPE "public"."routine_run_routine_name" AS ENUM('planner', 'executor', 'spike_ac_001_1', 'spike_ac_001_2', 'spike_ac_001_3', 'spike_ac_001_4', 'cap_status', 'replan_orchestrator');--> statement-breakpoint
CREATE TYPE "public"."routine_run_status" AS ENUM('running', 'completed', 'failed', 'degraded');--> statement-breakpoint
CREATE TABLE "agent_state" (
	"tenant_id" integer NOT NULL,
	"paused_bool" boolean DEFAULT false NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by" integer,
	CONSTRAINT "agent_state_tenant_id_pk" PRIMARY KEY("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "cap_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"date" date NOT NULL,
	"daily_used" integer NOT NULL,
	"daily_limit" integer DEFAULT 15 NOT NULL,
	"weekly_used" integer NOT NULL,
	"weekly_limit" integer NOT NULL,
	"source" "cap_usage_source" NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cap_usage_local" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"cap_kind" "cap_usage_local_kind" NOT NULL,
	"routine_runs_id" integer
);
--> statement-breakpoint
CREATE TABLE "channels_health" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"healthy_bool" boolean NOT NULL,
	"latency_ms" integer,
	"error" text,
	"restart_reason" "channels_restart_reason",
	"mute_alarm_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "executor_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"routine_run_id" integer NOT NULL,
	"pair" text NOT NULL,
	"session" text NOT NULL,
	"report_md_blob_url" text,
	"summary_md" text,
	"action_taken" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"mt5_ticket" bigint,
	"pair" text NOT NULL,
	"mt5_symbol" text NOT NULL,
	"type" "order_type" NOT NULL,
	"volume" numeric(18, 6),
	"price" numeric(18, 6),
	"sl" numeric(18, 6),
	"tp" numeric(18, 6),
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"source_table" text NOT NULL,
	"source_id" bigint NOT NULL,
	"status" "order_status" DEFAULT 'open' NOT NULL,
	"pnl" numeric(18, 6)
);
--> statement-breakpoint
CREATE TABLE "override_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_user_id" integer NOT NULL,
	"action_type" "override_action_type" NOT NULL,
	"target_pair" text,
	"target_ticket" bigint,
	"params_json" jsonb,
	"before_state_json" jsonb,
	"after_state_json" jsonb,
	"success" boolean,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "pair_configs" (
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"pair_code" text NOT NULL,
	"mt5_symbol" text NOT NULL,
	"sessions_json" jsonb NOT NULL,
	"active_bool" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pair_configs_tenant_id_pair_code_pk" PRIMARY KEY("tenant_id","pair_code")
);
--> statement-breakpoint
CREATE TABLE "pair_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"date" date NOT NULL,
	"pair_code" text NOT NULL,
	"session_name" text NOT NULL,
	"start_time_gmt" timestamp with time zone,
	"end_time_gmt" timestamp with time zone,
	"planner_run_id" integer,
	"scheduled_one_off_id" text,
	"status" "pair_schedule_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routine_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"routine_name" "routine_run_routine_name" NOT NULL,
	"pair" text,
	"session_window" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"claude_code_session_id" text,
	"claude_code_session_url" text,
	"input_text" text,
	"output_json" jsonb,
	"tool_calls_count" integer DEFAULT 0 NOT NULL,
	"status" "routine_run_status" DEFAULT 'running' NOT NULL,
	"failure_reason" text,
	"degraded" boolean DEFAULT false NOT NULL,
	"routine_fire_kind" "routine_fire_kind" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_interactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replied_at" timestamp with time zone,
	"from_user_id" bigint NOT NULL,
	"message_text" text NOT NULL,
	"command_parsed" text NOT NULL,
	"tool_calls_made_json" jsonb,
	"reply_text" text,
	"claude_code_session_id" text
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"allowed_telegram_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "authenticators" (
	"credential_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"provider_account_id" text NOT NULL,
	"credential_public_key" text NOT NULL,
	"counter" integer NOT NULL,
	"credential_device_type" text NOT NULL,
	"credential_backed_up" boolean NOT NULL,
	"transports" text,
	CONSTRAINT "authenticators_user_id_credential_id_pk" PRIMARY KEY("user_id","credential_id"),
	CONSTRAINT "authenticators_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"image" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_paused_by_users_id_fk" FOREIGN KEY ("paused_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cap_usage" ADD CONSTRAINT "cap_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cap_usage_local" ADD CONSTRAINT "cap_usage_local_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cap_usage_local" ADD CONSTRAINT "cap_usage_local_routine_runs_id_routine_runs_id_fk" FOREIGN KEY ("routine_runs_id") REFERENCES "public"."routine_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels_health" ADD CONSTRAINT "channels_health_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_reports" ADD CONSTRAINT "executor_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executor_reports" ADD CONSTRAINT "executor_reports_routine_run_id_routine_runs_id_fk" FOREIGN KEY ("routine_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_actions" ADD CONSTRAINT "override_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_actions" ADD CONSTRAINT "override_actions_operator_user_id_users_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_configs" ADD CONSTRAINT "pair_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_schedules" ADD CONSTRAINT "pair_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_schedules" ADD CONSTRAINT "pair_schedules_planner_run_id_routine_runs_id_fk" FOREIGN KEY ("planner_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_interactions" ADD CONSTRAINT "telegram_interactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticators" ADD CONSTRAINT "authenticators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cap_usage_tenant_date_idx" ON "cap_usage" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "cap_usage_tenant_date_source_uq" ON "cap_usage" USING btree ("tenant_id","date","source");--> statement-breakpoint
CREATE INDEX "cap_usage_local_tenant_at_idx" ON "cap_usage_local" USING btree ("tenant_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "channels_health_tenant_checked_idx" ON "channels_health" USING btree ("tenant_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "executor_reports_tenant_created_idx" ON "executor_reports" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_tenant_opened_idx" ON "orders" USING btree ("tenant_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_tenant_ticket_idx" ON "orders" USING btree ("tenant_id","mt5_ticket");--> statement-breakpoint
CREATE INDEX "override_actions_tenant_at_idx" ON "override_actions" USING btree ("tenant_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pair_schedules_tenant_date_idx" ON "pair_schedules" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE INDEX "pair_schedules_tenant_pair_date_idx" ON "pair_schedules" USING btree ("tenant_id","pair_code","date");--> statement-breakpoint
CREATE INDEX "routine_runs_tenant_started_at_idx" ON "routine_runs" USING btree ("tenant_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "routine_runs_tenant_name_started_at_idx" ON "routine_runs" USING btree ("tenant_id","routine_name","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tg_interactions_tenant_received_idx" ON "telegram_interactions" USING btree ("tenant_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tg_interactions_tenant_user_received_idx" ON "telegram_interactions" USING btree ("tenant_id","from_user_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tg_interactions_tenant_replied_idx" ON "telegram_interactions" USING btree ("tenant_id","replied_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");