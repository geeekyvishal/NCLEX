/**
 * Deck repository: a generated set of cards derived from a source.
 */
import type { Deck } from "@nclex/domain";
import { query } from "./db.js";
import { rowToDeck, type DeckRow } from "./mappers.js";

const COLUMNS = "id, user_id, source_id, title, status, card_count, created_at";

export const decks = {
  /**
   * Create a deck in the default `generating` status. It flips to `ready` once
   * the generation job persists its cards (see `markReady`).
   */
  async create(userId: string, sourceId: string, title: string): Promise<Deck> {
    const { rows } = await query<DeckRow>(
      `INSERT INTO decks (user_id, source_id, title)
       VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [userId, sourceId, title],
    );
    return rowToDeck(rows[0]);
  },

  async findById(id: string): Promise<Deck | null> {
    const { rows } = await query<DeckRow>(
      `SELECT ${COLUMNS} FROM decks WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? rowToDeck(rows[0]) : null;
  },

  /** List a user's decks, newest first. */
  async listByUser(userId: string): Promise<Deck[]> {
    const { rows } = await query<DeckRow>(
      `SELECT ${COLUMNS} FROM decks WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(rowToDeck);
  },

  /** Mark a deck ready and record its final card count once generation lands. */
  async markReady(id: string, cardCount: number): Promise<void> {
    await query(
      `UPDATE decks SET status = 'ready', card_count = $2 WHERE id = $1`,
      [id, cardCount],
    );
  },
};
