/**
 * Reviews repository: interacts with Postgres for cards and reviews tables.
 */
import { query, getPool } from "../../infra/db.js";
import { toIso } from "../../infra/mappers.js";
import { rescheduleCard } from "./scheduler.js";

export interface StudyCard {
  id: string;
  deckId: string;
  front: string;
  back: string;
  topic: string | null;
  confidence: number;
  sourceChunkId: string | null;
  modelVersion: string;
  flagged: boolean;
  createdAt: string;

  // FSRS scheduling columns
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: number;
  due: string;
  lastReview: string | null;
}

export interface StudyCardRow {
  id: string;
  deck_id: string;
  front: string;
  back: string;
  topic: string | null;
  confidence: number;
  source_chunk_id: string | null;
  model_version: string;
  flagged: boolean;
  created_at: Date | string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: number;
  due: Date | string;
  last_review: Date | string | null;
}

/**
 * Pure mapper from Postgres row to the camelCase StudyCard type.
 */
export function rowToStudyCard(row: StudyCardRow): StudyCard {
  return {
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
    stability: row.stability,
    difficulty: row.difficulty,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    due: toIso(row.due),
    lastReview: row.last_review ? toIso(row.last_review) : null,
  };
}

/**
 * pure helper to subtract one day from YYYY-MM-DD date string timezone-independently
 */
export function getPreviousDayStr(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export const reviews = {
  /**
   * List all cards in a deck that are due (i.e. due <= now()).
   */
  async listDue(deckId: string, now: Date = new Date()): Promise<StudyCard[]> {
    const { rows } = await query<StudyCardRow>(
      `SELECT id, deck_id, front, back, topic, confidence, source_chunk_id, model_version, flagged, created_at,
              stability, difficulty, reps, lapses, state, due, last_review
       FROM cards
       WHERE deck_id = $1 AND due <= $2
       ORDER BY state ASC, due ASC, id ASC`,
      [deckId, now],
    );
    return rows.map(rowToStudyCard);
  },

  /**
   * Log a review history event and update the card's scheduling state in a transaction.
   */
  async logReview(
    userId: string,
    cardId: string,
    rating: number,
    reviewTime: Date = new Date(),
  ): Promise<StudyCard> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 1. SELECT card FOR UPDATE to prevent race conditions
      const cardResult = await client.query<StudyCardRow>(
        `SELECT id, deck_id, front, back, topic, confidence, source_chunk_id, model_version, flagged, created_at,
                stability, difficulty, reps, lapses, state, due, last_review
         FROM cards
         WHERE id = $1
         FOR UPDATE`,
        [cardId],
      );

      if (cardResult.rows.length === 0) {
        throw new Error(`Card with ID ${cardId} not found`);
      }
      const dbCard = cardResult.rows[0];

      // 2. Fetch user custom FSRS params if any
      const paramsResult = await client.query<{ weights: number[]; request_retention: number }>(
        `SELECT weights, request_retention FROM fsrs_params WHERE user_id = $1`,
        [userId],
      );
      const userParams = paramsResult.rows[0]
        ? {
            weights: paramsResult.rows[0].weights,
            request_retention: paramsResult.rows[0].request_retention,
          }
        : undefined;

      // 3. Compute rescheduled card state
      const recordLogItem = rescheduleCard(
        {
          stability: dbCard.stability,
          difficulty: dbCard.difficulty,
          reps: dbCard.reps,
          lapses: dbCard.lapses,
          state: dbCard.state,
          due: dbCard.due,
          last_review: dbCard.last_review,
        },
        rating,
        reviewTime,
        userParams,
      );

      // 4. Update the card fields
      await client.query(
        `UPDATE cards
         SET stability = $1,
             difficulty = $2,
             reps = $3,
             lapses = $4,
             state = $5,
             due = $6,
             last_review = $7
         WHERE id = $8`,
        [
          recordLogItem.card.stability,
          recordLogItem.card.difficulty,
          recordLogItem.card.reps,
          recordLogItem.card.lapses,
          recordLogItem.card.state,
          recordLogItem.card.due,
          recordLogItem.card.last_review,
          cardId,
        ],
      );

      // 5. Insert the review log
      await client.query(
        `INSERT INTO reviews (user_id, card_id, rating, stability, difficulty, elapsed_days, scheduled_days, state, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          cardId,
          rating,
          recordLogItem.log.stability,
          recordLogItem.log.difficulty,
          recordLogItem.log.elapsed_days,
          recordLogItem.log.scheduled_days,
          recordLogItem.log.state,
          reviewTime,
        ],
      );

      await client.query("COMMIT");

      // Fetch the updated card row to ensure correctness and return the latest state
      const updatedCardResult = await query<StudyCardRow>(
        `SELECT id, deck_id, front, back, topic, confidence, source_chunk_id, model_version, flagged, created_at,
                stability, difficulty, reps, lapses, state, due, last_review
         FROM cards
         WHERE id = $1`,
        [cardId],
      );

      return rowToStudyCard(updatedCardResult.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Retrieves study statistics for a user (daily study streak, total cards studied, retention percentage based on ratings).
   */
  async getStats(
    userId: string,
    timezone: string = "UTC",
  ): Promise<{
    streak: number;
    totalReviews: number;
    totalCardsStudied: number;
    retentionRate: number;
  }> {
    // 1. Fetch counts
    const { rows: statsRows } = await query<{
      total_reviews: number;
      recalled_reviews: number;
      total_cards_studied: number;
    }>(
      `SELECT
         COUNT(*)::int as total_reviews,
         COUNT(*) FILTER (WHERE rating > 1)::int as recalled_reviews,
         COUNT(DISTINCT card_id)::int as total_cards_studied
       FROM reviews
       WHERE user_id = $1`,
      [userId],
    );

    const stats = statsRows[0] || { total_reviews: 0, recalled_reviews: 0, total_cards_studied: 0 };
    const totalReviews = Number(stats.total_reviews);
    const recalledReviews = Number(stats.recalled_reviews);
    const totalCardsStudied = Number(stats.total_cards_studied);

    // Retention percentage based on ratings (recalled if rating > 1, i.e., Hard, Good, Easy)
    const retentionRate = totalReviews > 0
      ? Math.round((recalledReviews / totalReviews) * 1000) / 10
      : 100.0;

    // 2. Compute study streak
    // Get today/yesterday in local timezone from PG
    const timeQuery = await query<{ local_today: string; local_yesterday: string }>(
      `SELECT (now() AT TIME ZONE $1)::date::text as local_today,
              ((now() - interval '1 day') AT TIME ZONE $1)::date::text as local_yesterday`,
      [timezone],
    );
    const { local_today, local_yesterday } = timeQuery.rows[0];

    // Get all distinct review dates for the user
    const datesQuery = await query<{ review_date: string }>(
      `SELECT DISTINCT (created_at AT TIME ZONE $2)::date::text as review_date
       FROM reviews
       WHERE user_id = $1
       ORDER BY review_date DESC`,
      [userId, timezone],
    );
    const reviewDates = new Set(datesQuery.rows.map((r) => r.review_date));

    let streak = 0;
    let checkDateStr = "";

    if (reviewDates.has(local_today)) {
      streak = 1;
      checkDateStr = local_today;
    } else if (reviewDates.has(local_yesterday)) {
      streak = 1;
      checkDateStr = local_yesterday;
    }

    if (streak > 0) {
      while (true) {
        const prevDateStr = getPreviousDayStr(checkDateStr);
        if (reviewDates.has(prevDateStr)) {
          streak++;
          checkDateStr = prevDateStr;
        } else {
          break;
        }
      }
    }

    return {
      streak,
      totalReviews,
      totalCardsStudied,
      retentionRate,
    };
  },
};
