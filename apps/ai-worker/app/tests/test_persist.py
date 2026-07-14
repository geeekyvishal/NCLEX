import pytest
import uuid
from unittest.mock import AsyncMock

from app.schemas import SourceChunk, VerifiedCard
from app.persist import persist


class FakeDbConn:
    def __init__(self):
        self.executed = []
        self._tx = AsyncMock()
        self._tx.__aenter__ = AsyncMock()
        self._tx.__aexit__ = AsyncMock()

    def transaction(self):
        return self._tx

    async def execute(self, query, *args):
        self.executed.append((query, args))
        return None


@pytest.mark.asyncio
async def test_persist_idempotent():
    deck_id = "22222222-2222-2222-2222-222222222222"
    source_id = "33333333-3333-3333-3333-333333333333"
    
    chunks = [
        SourceChunk(id="44444444-4444-4444-4444-444444444444", text="Chunk text 1", page=1, topic="topic1")
    ]
    embeddings = [[0.1] * 1536]
    cards = [
        VerifiedCard(
            front="Front?",
            back="Back",
            topic="topic1",
            source_chunk_id="44444444-4444-4444-4444-444444444444",
            confidence=0.9,
        )
    ]
    
    db_conn = FakeDbConn()
    
    await persist(
        deck_id=deck_id,
        source_id=source_id,
        chunks=chunks,
        embeddings=embeddings,
        cards=cards,
        conn=db_conn,
    )
    
    # Assert DELETE queries were run before INSERT queries
    executed_queries = [query.strip() for query, args in db_conn.executed]
    
    # Check that deletes are present
    assert any("DELETE FROM cards WHERE deck_id =" in q for q in executed_queries)
    assert any("DELETE FROM source_chunks WHERE source_id =" in q for q in executed_queries)
    
    # Verify the order: Deletes must happen before inserts
    delete_cards_idx = next(i for i, q in enumerate(executed_queries) if "DELETE FROM cards WHERE deck_id =" in q)
    delete_chunks_idx = next(i for i, q in enumerate(executed_queries) if "DELETE FROM source_chunks WHERE source_id =" in q)
    insert_chunks_idx = next(i for i, q in enumerate(executed_queries) if "INSERT INTO source_chunks" in q)
    insert_cards_idx = next(i for i, q in enumerate(executed_queries) if "INSERT INTO cards" in q)
    
    assert delete_cards_idx < insert_chunks_idx
    assert delete_cards_idx < insert_cards_idx
    assert delete_chunks_idx < insert_chunks_idx
    assert delete_chunks_idx < insert_cards_idx
