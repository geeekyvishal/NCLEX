/**
 * Shared domain contracts for the NCLEX app backend.
 *
 * These types are the single source of truth shared across the API service, the
 * clients, and (mirrored in Python) the AI worker. Changing a shape here is a
 * contract change - update the AI worker's Pydantic models to match.
 */
import { z } from "zod";

// ----------------------------------------------------------------------------
// Identity
// ----------------------------------------------------------------------------

/**
 * A user is a first-class record even before signup. Anonymous demo sessions
 * get a real user row so their generated decks are never lost, then upgrade to
 * a permanent account on magic-link sign-in.
 */
export const UserKind = z.enum(["anonymous", "registered"]);
export type UserKind = z.infer<typeof UserKind>;

export const User = z.object({
  id: z.string().uuid(),
  kind: UserKind,
  email: z.string().email().nullable(),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof User>;

// ----------------------------------------------------------------------------
// Content: sources, decks, cards
// ----------------------------------------------------------------------------

/** An uploaded PDF (or notes) that cards are generated from. */
export const Source = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  filename: z.string(),
  storageKey: z.string(),
  pageCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
});
export type Source = z.infer<typeof Source>;

export const DeckStatus = z.enum(["generating", "ready", "failed"]);
export type DeckStatus = z.infer<typeof DeckStatus>;

export const Deck = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  sourceId: z.string().uuid().nullable(),
  title: z.string(),
  status: DeckStatus,
  cardCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type Deck = z.infer<typeof Deck>;

export const Rating = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type Rating = z.infer<typeof Rating>;

export const CardState = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type CardState = z.infer<typeof CardState>;

/**
 * Every card stores its confidence and provenance (source chunk + model
 * version) so we can audit, surface low-confidence items, and regenerate.
 */
export const Card = z.object({
  id: z.string().uuid(),
  deckId: z.string().uuid(),
  front: z.string(),
  back: z.string(),
  topic: z.string().nullable(),
  /** 0..1 verifier confidence. Cards below the threshold are marked in the UI. */
  confidence: z.number().min(0).max(1),
  sourceChunkId: z.string().nullable(),
  modelVersion: z.string(),
  flagged: z.boolean().default(false),
  createdAt: z.string().datetime(),
  stability: z.number().default(0),
  difficulty: z.number().default(0),
  reps: z.number().int().default(0),
  lapses: z.number().int().default(0),
  state: CardState.default(0),
  due: z.string().datetime().default(() => new Date().toISOString()),
  lastReview: z.string().datetime().nullable().default(null),
});
export type Card = z.infer<typeof Card>;

/** Cards at or below this confidence are shown with a "verify this" marker. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

// ----------------------------------------------------------------------------
// Generation jobs (API <-> AI worker contract)
// ----------------------------------------------------------------------------

export const JobStage = z.enum([
  "queued",
  "parsing",
  "chunking",
  "generating",
  "verifying",
  "ranking",
  "persisting",
  "done",
  "failed",
]);
export type JobStage = z.infer<typeof JobStage>;

/** Payload the API enqueues for the AI worker to process one upload. */
export const GenerationJobRequest = z.object({
  jobId: z.string().uuid(),
  deckId: z.string().uuid(),
  sourceId: z.string().uuid(),
  storageKey: z.string(),
  /** Soft cap - the ranker keeps "the cards that matter, not 200 to delete". */
  targetCardCount: z.number().int().positive().default(25),
  prompt: z.string().optional(),
  cardId: z.string().uuid().optional(),
});
export type GenerationJobRequest = z.infer<typeof GenerationJobRequest>;

/** Progress event streamed from worker -> API -> client over WebSocket. */
export const JobProgress = z.object({
  jobId: z.string().uuid(),
  stage: JobStage,
  /** 0..1 overall progress for the client's progress bar. */
  progress: z.number().min(0).max(1),
  message: z.string().optional(),
});
export type JobProgress = z.infer<typeof JobProgress>;

// ----------------------------------------------------------------------------
// AI pipeline intermediate shapes (shared with the Python worker)
// ----------------------------------------------------------------------------

/** A semantic chunk of a parsed source, embedded for dedup and provenance. */
export const SourceChunk = z.object({
  id: z.string(),
  text: z.string(),
  page: z.number().int().nonnegative().nullable(),
  topic: z.string().nullable(),
});
export type SourceChunk = z.infer<typeof SourceChunk>;

/** A draft card before verification. */
export const DraftCard = z.object({
  front: z.string(),
  back: z.string(),
  topic: z.string().nullable(),
  sourceChunkId: z.string(),
});
export type DraftCard = z.infer<typeof DraftCard>;

/** Output of the verification pass for a single draft card. */
export const VerifiedCard = DraftCard.extend({
  confidence: z.number().min(0).max(1),
  /** Verifier may correct the back; keep the original for audit. */
  correctedBack: z.string().nullable(),
});
export type VerifiedCard = z.infer<typeof VerifiedCard>;

export const MODEL_VERSION = "claude-opus-4-8+haiku-4-5/v1";

// ----------------------------------------------------------------------------
// Spaced Repetition (FSRS) & Review models
// ----------------------------------------------------------------------------

export const FsrsParams = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  weights: z.array(z.number()),
  requestRetention: z.number().default(0.9),
  createdAt: z.string().datetime(),
});
export type FsrsParams = z.infer<typeof FsrsParams>;

export const Review = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  cardId: z.string().uuid(),
  rating: Rating,
  stability: z.number(),
  difficulty: z.number(),
  elapsedDays: z.number(),
  scheduledDays: z.number(),
  state: CardState,
  createdAt: z.string().datetime(),
});
export type Review = z.infer<typeof Review>;

/**
 * A element in the due queue represents a card that is due for review,
 * including its standard properties and FSRS scheduling state.
 */
export const DueQueueElement = Card;
export type DueQueueElement = z.infer<typeof DueQueueElement>;
