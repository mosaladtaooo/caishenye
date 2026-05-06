-- FR-023 D4 -- SimpleWebAuthn direct passkey flow.
--
-- Two tables to replace the broken Auth.js v5 WebAuthn beta path:
--   webauthn_credentials -- one row per registered passkey (phone + laptop)
--   webauthn_challenges  -- short-lived register / authenticate challenges
--
-- Constitution section 4 multi-tenant: tenant_id NOT NULL with FK to tenants.
-- Constitution section 16: snake_case columns.
--
-- Migration numbering: contract draft referenced "0011_v1_2_webauthn.sql"
-- assuming a long-form numbering scheme; actual sequential numbering on
-- this branch is 0003 (after 0000_init, 0001_seed_pairs,
-- 0002_v1_2_cron_runner_health). Sequential is the convention drizzle-kit
-- uses; this file matches that. Documented as positive drift in the
-- D4 implementation report.

CREATE TABLE "webauthn_credentials" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL,
        "credential_id" text NOT NULL,
        "public_key" "bytea" NOT NULL,
        "counter" bigint DEFAULT 0 NOT NULL,
        "transports" text[] DEFAULT '{}' NOT NULL,
        "nickname" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL,
        "challenge" text NOT NULL,
        "purpose" text NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "expires_at" timestamp with time zone NOT NULL,
        "consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_unique" ON "webauthn_credentials" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "webauthn_credentials_tenant_id_idx" ON "webauthn_credentials" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_tenant_purpose_idx" ON "webauthn_challenges" USING btree ("tenant_id","purpose");
