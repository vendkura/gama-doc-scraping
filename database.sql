DROP SCHEMA public CASCADE;

CREATE SCHEMA public;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (text text, n_tokens integer, file_path text, embeddings vector(1536));

CREATE INDEX ON documents USING ivfflat (embeddings vector_cosine_ops);

CREATE TABLE IF NOT EXISTS openai_ft_data (
  id SERIAL PRIMARY KEY,
  query TEXT NOT NULL,
  answer TEXT NOT NULL,
  suggested_answer TEXT,
  user_feedback BOOLEAN
);

CREATE TABLE IF NOT EXISTS usage (
  id SERIAL PRIMARY KEY,
  ip_address TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
