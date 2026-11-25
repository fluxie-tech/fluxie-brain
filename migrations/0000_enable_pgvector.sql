-- In docker-compose the superuser already installs pgvector (it is not a trusted extension);
-- this keeps other environments, where the migrator may be a superuser, self-sufficient.
CREATE EXTENSION IF NOT EXISTS vector;
