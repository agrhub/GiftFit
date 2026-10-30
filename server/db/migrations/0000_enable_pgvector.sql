-- pgvector is required by catalog.embedding (vector(1024)) and its HNSW index.
CREATE EXTENSION IF NOT EXISTS vector;
