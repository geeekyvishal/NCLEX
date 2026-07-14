import pytest
import uuid
from unittest.mock import AsyncMock, patch

from app.schemas import GenerationJobRequest, JobStage
from app.regenerate import run_regeneration


class FakeRedis:
    def __init__(self):
        self.published = []

    def publish(self, channel, message):
        self.published.append((channel, message))
        return None


class FakeDbConn:
    def __init__(self, card_rows=None, chunk_rows=None, deck_row=None):
        self.executed = []
        self._tx = AsyncMock()
        self._tx.__aenter__ = AsyncMock()
        self._tx.__aexit__ = AsyncMock()
        self.card_rows = card_rows or []
        self.chunk_rows = chunk_rows or []
        self.deck_row = deck_row

    def transaction(self):
        return self._tx

    async def execute(self, query, *args):
        self.executed.append((query, args))
        return None

    async def fetch(self, query, *args):
        self.executed.append((query, args))
        if "FROM cards" in query:
            return self.card_rows
        if "FROM source_chunks" in query:
            return self.chunk_rows
        return []

    async def fetchrow(self, query, *args):
        self.executed.append((query, args))
        if "FROM cards" in query:
            if self.card_rows:
                if len(args) > 0:
                    for row in self.card_rows:
                        if str(row["id"]) == str(args[0]):
                            return row
                return self.card_rows[0]
            return None
        if "FROM source_chunks" in query:
            if self.chunk_rows:
                if len(args) > 0:
                    for row in self.chunk_rows:
                        if str(row["id"]) == str(args[0]):
                            return row
                return self.chunk_rows[0]
            return None
        if "FROM decks" in query:
            return self.deck_row
        return None


class FakeLLMClient:
    def __init__(self, complete_json_val=None):
        self.calls = []
        self.complete_json_val = complete_json_val

    def complete_json(self, model, system, user, max_tokens=2048):
        self.calls.append((model, system, user, max_tokens))
        if self.complete_json_val is not None:
            return self.complete_json_val
        # Default responses based on system prompt
        if "editing a flashcard" in system:
            return {
                "front": "Edited Front",
                "back": "Edited Back",
                "topic": "Edited Topic"
            }
        elif "deck-wide edit" in system:
            return [
                {
                    "action": "keep",
                    "card_id": "11111111-1111-1111-1111-111111111111",
                    "front": "Keep Front",
                    "back": "Keep Back",
                    "topic": "Keep Topic",
                    "source_chunk_id": "44444444-4444-4444-4444-444444444444"
                },
                {
                    "action": "edit",
                    "card_id": "22222222-2222-2222-2222-222222222222",
                    "front": "New Front",
                    "back": "New Back",
                    "topic": "New Topic",
                    "source_chunk_id": "44444444-4444-4444-4444-444444444444"
                },
                {
                    "action": "add",
                    "front": "Added Front",
                    "back": "Added Back",
                    "topic": "Added Topic",
                    "source_chunk_id": "44444444-4444-4444-4444-444444444444"
                },
                {
                    "action": "delete",
                    "card_id": "33333333-3333-3333-3333-333333333333"
                }
            ]
        elif "meticulous NCLEX fact-checker" in system:
            return {
                "confidence": 0.95,
                "correctedBack": None,
            }
        return None


@pytest.mark.asyncio
async def test_card_specific_regeneration_changed():
    deck_id = "00000000-0000-0000-0000-000000000000"
    card_id = "11111111-1111-1111-1111-111111111111"
    chunk_id = "44444444-4444-4444-4444-444444444444"
    job_id = "99999999-9999-9999-9999-999999999999"

    req = {
        "job_id": job_id,
        "deck_id": deck_id,
        "prompt": "Fix spelling",
        "card_id": card_id,
    }

    card_rows = [{
        "id": uuid.UUID(card_id),
        "deck_id": uuid.UUID(deck_id),
        "front": "Original Front",
        "back": "Original Back",
        "topic": "Original Topic",
        "confidence": 0.8,
        "source_chunk_id": uuid.UUID(chunk_id),
        "model_version": "v1",
        "flagged": False,
    }]
    chunk_rows = [{
        "id": uuid.UUID(chunk_id),
        "text": "Some source text",
        "page": 1,
        "topic": "Original Topic",
    }]

    db_conn = FakeDbConn(card_rows=card_rows, chunk_rows=chunk_rows)
    redis_client = FakeRedis()
    llm_client = FakeLLMClient()

    await run_regeneration(
        req,
        redis_client=redis_client,
        db_conn=db_conn,
        llm_client=llm_client,
    )

    # 1. Assert LLM calls were made
    assert len(llm_client.calls) == 2  # 1 complete_json for edit, 1 for verify
    assert "editing a flashcard" in llm_client.calls[0][1]
    assert "NCLEX fact-checker" in llm_client.calls[1][1]

    # 2. Assert DB queries update the card and delete review logs because it changed
    queries = [q[0] for q in db_conn.executed]
    
    # Check UPDATE query resets stability/difficulty etc.
    update_query = next((q for q in queries if "UPDATE cards" in q and "stability = 0.0" in q), None)
    assert update_query is not None

    # Check review logs deletion is executed
    delete_reviews_query = next((q for q in queries if "DELETE FROM reviews WHERE card_id =" in q), None)
    assert delete_reviews_query is not None


@pytest.mark.asyncio
async def test_card_specific_regeneration_unchanged():
    deck_id = "00000000-0000-0000-0000-000000000000"
    card_id = "11111111-1111-1111-1111-111111111111"
    chunk_id = "44444444-4444-4444-4444-444444444444"
    job_id = "99999999-9999-9999-9999-999999999999"

    req = {
        "job_id": job_id,
        "deck_id": deck_id,
        "prompt": "Fix spelling",
        "card_id": card_id,
    }

    card_rows = [{
        "id": uuid.UUID(card_id),
        "deck_id": uuid.UUID(deck_id),
        "front": "Keep Front",
        "back": "Keep Back",
        "topic": "Original Topic",
        "confidence": 0.8,
        "source_chunk_id": uuid.UUID(chunk_id),
        "model_version": "v1",
        "flagged": False,
    }]
    chunk_rows = [{
        "id": uuid.UUID(chunk_id),
        "text": "Some source text",
        "page": 1,
        "topic": "Original Topic",
    }]

    # LLM returns the exact same front/back
    llm_client = FakeLLMClient(complete_json_val={
        "front": "Keep Front",
        "back": "Keep Back",
        "topic": "Keep Topic"
    })
    db_conn = FakeDbConn(card_rows=card_rows, chunk_rows=chunk_rows)
    redis_client = FakeRedis()

    await run_regeneration(
        req,
        redis_client=redis_client,
        db_conn=db_conn,
        llm_client=llm_client,
    )

    queries = [q[0] for q in db_conn.executed]
    
    # It should UPDATE cards without resetting stability
    update_query = next((q for q in queries if "UPDATE cards" in q and "topic =" in q and "stability" not in q), None)
    assert update_query is not None

    # It should NOT delete review logs
    delete_reviews_query = next((q for q in queries if "DELETE FROM reviews" in q), None)
    assert delete_reviews_query is None


@pytest.mark.asyncio
async def test_deck_wide_regeneration():
    deck_id = "00000000-0000-0000-0000-000000000000"
    source_id = "55555555-5555-5555-5555-555555555555"
    chunk_id = "44444444-4444-4444-4444-444444444444"
    job_id = "99999999-9999-9999-9999-999999999999"

    req = {
        "job_id": job_id,
        "deck_id": deck_id,
        "source_id": source_id,
        "prompt": "Regenerate whole deck focusing on pharmacology",
    }

    card_rows = [
        # Action keep
        {
            "id": uuid.UUID("11111111-1111-1111-1111-111111111111"),
            "deck_id": uuid.UUID(deck_id),
            "front": "Keep Front",
            "back": "Keep Back",
            "topic": "Keep Topic",
            "confidence": 0.8,
            "source_chunk_id": uuid.UUID(chunk_id),
            "model_version": "v1",
            "flagged": False,
        },
        # Action edit
        {
            "id": uuid.UUID("22222222-2222-2222-2222-222222222222"),
            "deck_id": uuid.UUID(deck_id),
            "front": "Original Front 2",
            "back": "Original Back 2",
            "topic": "Original Topic 2",
            "confidence": 0.8,
            "source_chunk_id": uuid.UUID(chunk_id),
            "model_version": "v1",
            "flagged": False,
        },
        # Action delete
        {
            "id": uuid.UUID("33333333-3333-3333-3333-333333333333"),
            "deck_id": uuid.UUID(deck_id),
            "front": "Original Front 3",
            "back": "Original Back 3",
            "topic": "Original Topic 3",
            "confidence": 0.8,
            "source_chunk_id": uuid.UUID(chunk_id),
            "model_version": "v1",
            "flagged": False,
        }
    ]
    chunk_rows = [{
        "id": uuid.UUID(chunk_id),
        "text": "Some source text",
        "page": 1,
        "topic": "Original Topic",
    }]
    deck_row = {"source_id": uuid.UUID(source_id)}

    db_conn = FakeDbConn(card_rows=card_rows, chunk_rows=chunk_rows, deck_row=deck_row)
    redis_client = FakeRedis()
    llm_client = FakeLLMClient()

    await run_regeneration(
        req,
        redis_client=redis_client,
        db_conn=db_conn,
        llm_client=llm_client,
    )

    queries = [q[0] for q in db_conn.executed]

    # Verify deck-wide updates executed:
    # 1. DELETE query for card 33333333
    delete_cards_query = next((q for q, args in db_conn.executed if "DELETE FROM cards WHERE id = ANY($1)" in q), None)
    assert delete_cards_query is not None

    # 2. UPDATE query for edited card 22222222 resetting scheduling
    edit_query = next((q for q in queries if "UPDATE cards" in q and "stability = 0.0" in q), None)
    assert edit_query is not None

    # 3. INSERT query for added card
    insert_query = next((q for q in queries if "INSERT INTO cards" in q), None)
    assert insert_query is not None

    # 4. UPDATE query for deck count
    update_deck_query = next((q for q in queries if "UPDATE decks" in q and "card_count =" in q), None)
    assert update_deck_query is not None
