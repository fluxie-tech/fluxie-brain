CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "entity_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"proposed" jsonb NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"proposed_by" text NOT NULL,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "entity_proposals" ADD CONSTRAINT "entity_proposals_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_proposals_entity_id_status_index" ON "entity_proposals" USING btree ("entity_id","status");