/**
 * Pure mappers from snake_case Postgres rows to the camelCase domain types.
 *
 * These functions contain no I/O so they are unit-testable without a live
 * database (see mappers.test.ts). Each mapper validates its output against the
 * corresponding Zod schema from @nclex/domain, which converts and enforces the
 * shape at the boundary and turns any drift between the schema and this code
 * into a loud, immediate failure rather than a silent bad value.
 *
 * Postgres returns TIMESTAMPTZ columns as JS `Date` objects (via node-pg), and
 * the domain schemas require ISO-8601 strings, so timestamps are converted with
 * `toISOString()` before validation.
 */
import { User, Source, Deck, Card } from "@nclex/domain";

/** A TIMESTAMPTZ column as delivered by node-pg (Date), tolerating strings. */
type Timestamp = Date | string;

/** Normalise a Postgres timestamp value to an ISO-8601 string. */
export function toIso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// --- Row shapes (as returned by SELECT * on each table) ---

export interface UserRow {
  id: string;
  kind: string;
  email: string | null;
  created_at: Timestamp;
}

export interface SourceRow {
  id: string;
  user_id: string;
  filename: string;
  storage_key: string;
  page_count: number | null;
  created_at: Timestamp;
}

export interface DeckRow {
  id: string;
  user_id: string;
  source_id: string | null;
  title: string;
  status: string;
  card_count: number;
  created_at: Timestamp;
}

export interface CardRow {
  id: string;
  deck_id: string;
  front: string;
  back: string;
  topic: string | null;
  confidence: number;
  source_chunk_id: string | null;
  model_version: string;
  flagged: boolean;
  created_at: Timestamp;
}

// --- Mappers ---

export function rowToUser(row: UserRow): User {
  return User.parse({
    id: row.id,
    kind: row.kind,
    email: row.email,
    createdAt: toIso(row.created_at),
  });
}

export function rowToSource(row: SourceRow): Source {
  return Source.parse({
    id: row.id,
    userId: row.user_id,
    filename: row.filename,
    storageKey: row.storage_key,
    pageCount: row.page_count,
    createdAt: toIso(row.created_at),
  });
}

export function rowToDeck(row: DeckRow): Deck {
  return Deck.parse({
    id: row.id,
    userId: row.user_id,
    sourceId: row.source_id,
    title: row.title,
    status: row.status,
    cardCount: row.card_count,
    createdAt: toIso(row.created_at),
  });
}

export function rowToCard(row: CardRow): Card {
  return Card.parse({
    id: row.id,
    deckId: row.deck_id,
    front: row.front,
    back: row.back,
    topic: row.topic,
    confidence: row.confidence,
    sourceChunkId: row.source_chunk_id,
    modelVersion: row.model_version,
    flagged: row.flagged,
    createdAt: toIso(row.created_at),
  });
}
