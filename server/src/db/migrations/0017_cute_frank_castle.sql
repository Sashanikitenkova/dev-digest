CREATE TABLE "eval_run_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"agent_version" integer,
	"system_prompt" text NOT NULL,
	"skills_snapshot" jsonb,
	"provider" text,
	"model" text,
	"recall" double precision,
	"precision" double precision,
	"citation_accuracy" double precision,
	"traces_passed" integer DEFAULT 0 NOT NULL,
	"traces_total" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" double precision,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "source_finding_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "tp" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "fp" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "fn" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "kept" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "dropped" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "tokens_in" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "tokens_out" integer;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "eval_run_batches" ADD CONSTRAINT "eval_run_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_batches_owner_idx" ON "eval_run_batches" USING btree ("workspace_id","owner_kind","owner_id");--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_source_finding_id_findings_id_fk" FOREIGN KEY ("source_finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_batch_id_eval_run_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."eval_run_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_cases_owner_idx" ON "eval_cases" USING btree ("workspace_id","owner_kind","owner_id");--> statement-breakpoint
CREATE INDEX "eval_cases_source_finding_idx" ON "eval_cases" USING btree ("source_finding_id");--> statement-breakpoint
CREATE INDEX "eval_runs_batch_idx" ON "eval_runs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "eval_runs_case_ran_idx" ON "eval_runs" USING btree ("case_id","ran_at");