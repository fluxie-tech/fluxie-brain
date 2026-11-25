-- Full-text leg of the hybrid search (embeddings module). Custom because the entities table is declared
-- in core-graph's schema.ts, which the embeddings module does not change (SPEC-embeddings.md).
CREATE INDEX IF NOT EXISTS "entities_tsv_gin_index" ON "entities" USING gin ("tsv");
