/**
 * Card repository: individual flashcards with confidence and provenance.
 */
import type { Card } from "@nclex/domain";
import { query } from "./db.js";
import { rowToCard, type CardRow } from "./mappers.js";

const COLUMNS =
  "id, deck_id, front, back, topic, confidence, source_chunk_id, model_version, flagged, created_at";

export const cards = {
  /** List a deck's cards in stable creation order. */
  async listByDeck(deckId: string): Promise<Card[]> {
    const { rows } = await query<CardRow>(
      `SELECT ${COLUMNS} FROM cards WHERE deck_id = $1 ORDER BY created_at ASC`,
      [deckId],
    );
    return rows.map(rowToCard);
  },

  /** Flag a card for regeneration (feeds the flag-and-fix loop). */
  async flag(cardId: string): Promise<void> {
    await query(`UPDATE cards SET flagged = TRUE WHERE id = $1`, [cardId]);
  },
};
