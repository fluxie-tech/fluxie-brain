-- BM25 text leg of the hybrid search (SPEC-embeddings.md, Emenda 1), one index per language on the same expression.
-- Custom because the entities table is declared in core-graph's schema.ts, which the embeddings module does not change.
-- In docker-compose the superuser already installs pg_textsearch (init-db.sh); this keeps other environments
-- self-sufficient, like 0000 does for pgvector.
CREATE EXTENSION IF NOT EXISTS pg_textsearch;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_bm25_pt" ON "entities" USING bm25 (("title" || ' ' || "content")) WITH (text_config = 'portuguese');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_bm25_en" ON "entities" USING bm25 (("title" || ' ' || "content")) WITH (text_config = 'english');
