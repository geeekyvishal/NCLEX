-- Migration: 0002_study
-- Alters cards and creates fsrs_params and reviews tables.

ALTER TABLE cards
  ADD COLUMN stability REAL DEFAULT 0,
  ADD COLUMN difficulty REAL DEFAULT 0,
  ADD COLUMN reps INT DEFAULT 0,
  ADD COLUMN lapses INT DEFAULT 0,
  ADD COLUMN state INT DEFAULT 0,
  ADD COLUMN due TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN last_review TIMESTAMPTZ;

CREATE INDEX idx_cards_due ON cards(deck_id, due);

CREATE TABLE fsrs_params (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weights JSONB NOT NULL,
  request_retention REAL NOT NULL DEFAULT 0.9,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating INT NOT NULL CHECK (rating >= 1 AND rating <= 4),
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  elapsed_days REAL NOT NULL,
  scheduled_days REAL NOT NULL,
  state INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reviews_card ON reviews(card_id);
CREATE INDEX idx_reviews_user ON reviews(user_id);
