"""Stage 7: Persist.

Writes the generated chunks (with embeddings) and selected cards to the database
within a transaction, then updates the deck status and count.
"""
from __future__ import annotations

import logging
import uuid
import asyncpg

from .config import settings
from .schemas import SourceChunk, VerifiedCard, MODEL_VERSION

logger = logging.getLogger(__name__)


def _to_uuid(val: str | None) -> uuid.UUID | None:
    """Helper to convert a string representation to a UUID or return None."""
    if not val:
        return None
    try:
        return uuid.UUID(val)
    except ValueError:
        return None


async def persist(
    deck_id: str,
    source_id: str,
    chunks: list[SourceChunk],
    embeddings: list[list[float]],
    cards: list[VerifiedCard],
    conn: asyncpg.Connection | None = None,
) -> None:
    """Write generated source chunks and cards to Postgres, then update the deck.

    Runs within a transaction. If `conn` is not provided, connects to the database
    using `settings.database_url`.
    """
    if conn is None:
        async with await asyncpg.connect(settings.database_url) as new_conn:
            await _persist_tx(deck_id, source_id, chunks, embeddings, cards, new_conn)
    else:
        await _persist_tx(deck_id, source_id, chunks, embeddings, cards, conn)


async def _persist_tx(
    deck_id: str,
    source_id: str,
    chunks: list[SourceChunk],
    embeddings: list[list[float]],
    cards: list[VerifiedCard],
    conn: asyncpg.Connection,
) -> None:
    """Execute the persistence statements inside a transaction."""
    async with conn.transaction():
        # 1. Insert source chunks
        for chunk, emb in zip(chunks, embeddings):
            emb_str = f"[{','.join(str(x) for x in emb)}]"
            await conn.execute(
                """
                INSERT INTO source_chunks (id, source_id, text, page, topic, embedding)
                VALUES ($1, $2, $3, $4, $5, $6)
                """,
                uuid.UUID(chunk.id),
                uuid.UUID(source_id),
                chunk.text,
                chunk.page,
                chunk.topic,
                emb_str,
            )

        # 2. Insert cards
        for card in cards:
            await conn.execute(
                """
                INSERT INTO cards (deck_id, front, back, topic, confidence, source_chunk_id, model_version, flagged)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """,
                uuid.UUID(deck_id),
                card.front,
                card.effective_back,
                card.topic,
                card.confidence,
                _to_uuid(card.source_chunk_id),
                MODEL_VERSION,
                False,
            )

        # 3. Update deck status and count
        await conn.execute(
            """
            UPDATE decks
            SET status = 'ready', card_count = $2
            WHERE id = $1
            """,
            uuid.UUID(deck_id),
            len(cards),
        )

    logger.info("Persisted %d chunks and %d cards for deck %s", len(chunks), len(cards), deck_id)
