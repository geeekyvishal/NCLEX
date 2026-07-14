-- NCLEX app - demo-path schema (Postgres 16 + pgvector)
-- Owns: users (anonymous + registered), sources, decks, cards, generation jobs.
-- Study/FSRS, billing, and referral tables are intentionally out of scope for
-- the demo slice and will be added in later migrations.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- Users are first-class even when anonymous, so demo work is never lost.
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind        TEXT NOT NULL CHECK (kind IN ('anonymous', 'registered')),
  email       TEXT UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An uploaded PDF or notes file. The binary lives in object storage; we keep
-- only the key and metadata here.
CREATE TABLE sources (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  storage_key  TEXT NOT NULL,
  page_count   INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sources_user ON sources(user_id);

CREATE TABLE decks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id   UUID REFERENCES sources(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'generating'
                CHECK (status IN ('generating', 'ready', 'failed')),
  card_count  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_decks_user ON decks(user_id);

-- Semantic chunks of a parsed source. Embedding supports dedup and lets each
-- card point back to the exact chunk it came from (provenance).
CREATE TABLE source_chunks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id   UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  page        INT,
  topic       TEXT,
  embedding   vector(1536),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chunks_source ON source_chunks(source_id);
CREATE INDEX idx_chunks_embedding ON source_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Cards carry confidence + provenance so low-confidence items can be surfaced
-- (never silently hidden) and regenerated when flagged.
CREATE TABLE cards (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deck_id          UUID NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  front            TEXT NOT NULL,
  back             TEXT NOT NULL,
  topic            TEXT,
  confidence       REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_chunk_id  UUID REFERENCES source_chunks(id) ON DELETE SET NULL,
  model_version    TEXT NOT NULL,
  flagged          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cards_deck ON cards(deck_id);

-- Generation jobs track the async AI pipeline for one upload.
CREATE TABLE generation_jobs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deck_id     UUID NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  source_id   UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL DEFAULT 'queued',
  progress    REAL NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_deck ON generation_jobs(deck_id);
