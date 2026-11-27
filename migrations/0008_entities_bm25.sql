-- BM25 text leg of the hybrid search (SPEC-embeddings.md, Emenda 1), one index per language on the same expression.
-- Custom because the entities table is declared in core-graph's schema.ts, which the embeddings module does not change.
-- pg_textsearch needs a superuser to CREATE EXTENSION and a server started with shared_preload_libraries. In
-- docker-compose init-db.sh does it as the superuser, so with those already in place the statement below is a no-op.
-- Without them (a non-superuser migrator, or a pgdata volume created before the pg_textsearch image) this migration
-- fails on the statements below: rebuild the image (`docker compose build db`), recreate the container and run
-- `CREATE EXTENSION IF NOT EXISTS pg_textsearch;` as `postgres` in each database, then migrate again.
CREATE EXTENSION IF NOT EXISTS pg_textsearch;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_bm25_pt" ON "entities" USING bm25 (("title" || ' ' || "content")) WITH (text_config = 'portuguese');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entities_bm25_en" ON "entities" USING bm25 (("title" || ' ' || "content")) WITH (text_config = 'english');
