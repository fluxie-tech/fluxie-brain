CREATE TABLE "entity_embeddings" (
	"entity_id" uuid NOT NULL,
	"model" text NOT NULL,
	"source_hash" text NOT NULL,
	"embedding" vector NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_embeddings_entity_id_model_pk" PRIMARY KEY("entity_id","model")
);
--> statement-breakpoint
ALTER TABLE "entity_embeddings" ADD CONSTRAINT "entity_embeddings_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;