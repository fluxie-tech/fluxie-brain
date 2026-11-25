CREATE TYPE "public"."change_action" AS ENUM('create', 'update', 'status', 'propose', 'accept', 'reject', 'unlink', 'revert');--> statement-breakpoint
CREATE TYPE "public"."entity_status" AS ENUM('draft', 'approved', 'deprecated', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."target_kind" AS ENUM('entity', 'relation', 'proposal');--> statement-breakpoint
CREATE TABLE "change_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"target_kind" "target_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"action" "change_action" NOT NULL,
	"actor" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "entity_status" NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"content_hash" text GENERATED ALWAYS AS (md5("title" || E'
' || "content")) STORED,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "title" || ' ' || "content")) STORED,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_spaceId_key_unique" UNIQUE("space_id","key"),
	CONSTRAINT "entities_confidence_range" CHECK ("entities"."confidence" between 0 and 1)
);
--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_log_target_id_created_at_index" ON "change_log" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE INDEX "entities_space_id_type_status_index" ON "entities" USING btree ("space_id","type","status");