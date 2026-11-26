-- The text leg moved to the BM25 indexes of 0008 (SPEC-embeddings.md, Emenda 1), so nothing queries entities.tsv with
-- @@ any more and this GIN index only costs writes. The tsv column itself belongs to core-graph and stays.
DROP INDEX IF EXISTS "entities_tsv_gin_index";
