import pytest
from unittest.mock import AsyncMock, patch

from app.schemas import GenerationJobRequest, JobStage
from app.pipeline import run_pipeline
from app.parse import ParsedPage


class FakeRedis:
    def __init__(self):
        self.published = []

    def publish(self, channel, message):
        self.published.append((channel, message))
        return None


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


class FakeLLMClient:
    def __init__(self):
        self.calls = []

    def complete_json(self, model, system, user, max_tokens=2048):
        self.calls.append((model, system, user, max_tokens))
        if "expert NCLEX nurse educator" in system:
            return [
                {"front": "Antidote for warfarin?", "back": "Vitamin K"},
                {"front": "Normal range for potassium?", "back": "3.5 to 5.0 mEq/L"},
            ]
        elif "meticulous NCLEX fact-checker" in system:
            return {
                "confidence": 0.9,
                "correctedBack": None,
            }
        return []


class FakeEmbedder:
    def embed_texts(self, texts):
        return [[0.1] * 1536 for _ in texts]


@pytest.mark.asyncio
async def test_run_pipeline_success():
    req = GenerationJobRequest(
        job_id="11111111-1111-1111-1111-111111111111",
        deck_id="22222222-2222-2222-2222-222222222222",
        source_id="33333333-3333-3333-3333-333333333333",
        storage_key="sources/test.pdf",
        target_card_count=5,
    )

    redis_client = FakeRedis()
    db_conn = FakeDbConn()
    llm_client = FakeLLMClient()
    embedder = FakeEmbedder()

    # Predefined pages to bypass S3 and PDF parsing.
    pages = [
        ParsedPage(page=1, text="Pharmacology details: Warfarin is an anticoagulant. The antidote is Vitamin K."),
        ParsedPage(page=2, text="Lab values details: Normal potassium levels are 3.5 to 5.0 mEq/L."),
    ]

    with patch("app.pipeline.parse", return_value=pages):
        await run_pipeline(
            req,
            redis_client=redis_client,
            db_conn=db_conn,
            llm_client=llm_client,
            embedder=embedder,
        )

    # 1. Assert Redis progress updates were sent
    stages_sent = []
    for chan, msg in redis_client.published:
        assert chan == "job:progress"
        import json
        data = json.loads(msg)
        assert data["jobId"] == req.job_id
        stages_sent.append(data["stage"])

    assert "parsing" in stages_sent
    assert "chunking" in stages_sent
    assert "generating" in stages_sent
    assert "verifying" in stages_sent
    assert "ranking" in stages_sent
    assert "persisting" in stages_sent
    assert "done" in stages_sent

    # 2. Assert DB queries were run
    executed_queries = [q[0] for q in db_conn.executed]
    assert any("UPDATE sources" in q for q in executed_queries)
    assert any("INSERT INTO source_chunks" in q for q in executed_queries)
    assert any("INSERT INTO cards" in q for q in executed_queries)
    assert any("UPDATE decks" in q for q in executed_queries)
