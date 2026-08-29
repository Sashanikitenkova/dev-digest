CREATE TABLE "skill_context_files" (
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "skill_context_files_skill_id_path_pk" PRIMARY KEY("skill_id","path")
);
--> statement-breakpoint
CREATE TABLE "agent_context_files" (
	"agent_id" uuid NOT NULL,
	"path" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_context_files_agent_id_path_pk" PRIMARY KEY("agent_id","path")
);
--> statement-breakpoint
ALTER TABLE "skill_context_files" ADD CONSTRAINT "skill_context_files_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_files" ADD CONSTRAINT "agent_context_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;