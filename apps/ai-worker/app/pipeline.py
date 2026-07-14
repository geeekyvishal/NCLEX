"""Orchestrator for the card generation pipeline.

Coordinates PDF download, parsing, chunking, embedding, deduplication, topic
tagging, drafting, verification, ranking, and final database persistence,
while reporting progress to Redis and Postgres.
"""
from __future__ import annotations

import inspect
import logging
import uuid
import asyncpg
import redis.asyncio as aioredis
from typing import Any

from .config import settings
from .schemas import GenerationJobRequest, JobProgress, JobStage
from .parse import parse
from .chunk import chunk_pages
from .embed import embed_texts
from .dedup import dedup_chunks, tag_chunks
from .generate import generate
from .verify import verify
from .rank import rank
from .persist import persist

logger = logging.getLogger(__name__)


async def run_pipeline(
    request: GenerationJobRequest,
    *,
    redis_client: Any = None,
    db_conn: asyncpg.Connection | None = None,
    store: Any = None,
    llm_client: Any = None,
    embedder: Any = None,
) -> None:
    """Run all pipeline stages for a generation job.

    Logs progress after each stage and updates job/deck tables in Postgres.
    """
    job_id = request.job_id
    deck_id = request.deck_id
    source_id = request.source_id
    storage_key = request.storage_key
    target_count = request.target_card_count

    # Resolve default clients if not injected
    if redis_client is None:
        redis_client = aioredis.from_url(settings.redis_url)

    close_db_conn = False
    if db_conn is None:
        db_conn = await asyncpg.connect(settings.database_url)
        close_db_conn = True

    async def publish_progress(stage: JobStage, progress: float, message: str | None = None) -> None:
        logger.info(
            "Job %s progress: stage=%s, progress=%f, msg=%s",
            job_id,
            stage.value,
            progress,
            message,
        )

        # 1. Publish to Redis pub/sub
        prog_event = JobProgress(
            job_id=job_id,
            stage=stage,
            progress=progress,
            message=message,
        )
        res = redis_client.publish(
            settings.job_progress_channel,
            prog_event.model_dump_json(by_alias=True),
        )
        if inspect.iscoroutine(res):
            await res

        # 2. Update generation_jobs in DB
        await db_conn.execute(
            """
            UPDATE generation_jobs
            SET stage = $2, progress = $3, error = $4, updated_at = now()
            WHERE id = $1
            """,
            uuid.UUID(job_id),
            stage.value,
            progress,
            message,
        )

    try:
        # --- Stage 1: Parsing ---
        await publish_progress(JobStage.PARSING, 0.1, "Downloading and parsing PDF...")
        pages = parse(storage_key, store=store)

        await db_conn.execute(
            "UPDATE sources SET page_count = $2 WHERE id = $1",
            uuid.UUID(source_id),
            len(pages),
        )

        # --- Stage 2: Chunking ---
        await publish_progress(JobStage.CHUNKING, 0.25, "Chunking document text...")
        chunks = chunk_pages(pages)

        if not chunks:
            await publish_progress(JobStage.DONE, 1.0, "No text chunks generated.")
            await db_conn.execute(
                "UPDATE decks SET status = 'ready', card_count = 0 WHERE id = $1",
                uuid.UUID(deck_id),
            )
            return

        # --- Stage 3: Embedding, Dedup, and Tagging ---
        chunk_texts = [c.text for c in chunks]
        embeddings = embed_texts(chunk_texts, embedder=embedder)

        kept_chunks, kept_embeddings = dedup_chunks(chunks, embeddings)
        tag_chunks(kept_chunks)

        # --- Stage 4: Generating ---
        await publish_progress(
            JobStage.GENERATING,
            0.4,
            f"Generating draft cards for {len(kept_chunks)} chunks...",
        )
        drafts = generate(kept_chunks, client=llm_client)

        if not drafts:
            await publish_progress(JobStage.DONE, 1.0, "No cards drafted.")
            await db_conn.execute(
                "UPDATE decks SET status = 'ready', card_count = 0 WHERE id = $1",
                uuid.UUID(deck_id),
            )
            return

        # --- Stage 5: Verifying ---
        await publish_progress(
            JobStage.VERIFYING,
            0.7,
            f"Verifying {len(drafts)} draft cards...",
        )
        verified = verify(drafts, kept_chunks, client=llm_client)

        # --- Stage 6: Ranking ---
        await publish_progress(
            JobStage.RANKING,
            0.85,
            "Ranking and spreading cards by topic...",
        )
        kept_cards = rank(verified, target_count)

        # --- Stage 7: Persisting ---
        await publish_progress(
            JobStage.PERSISTING,
            0.95,
            f"Saving {len(kept_cards)} cards to deck...",
        )
        await persist(
            deck_id=deck_id,
            source_id=source_id,
            chunks=kept_chunks,
            embeddings=kept_embeddings,
            cards=kept_cards,
            conn=db_conn,
        )

        await publish_progress(JobStage.DONE, 1.0, "Deck generation completed successfully.")

    except Exception as exc:
        logger.exception("Pipeline failed for job %s", job_id)

        try:
            await publish_progress(JobStage.FAILED, 1.0, str(exc))
        except Exception:
            logger.exception("Failed to write failure progress to DB/Redis")

        try:
            await db_conn.execute(
                "UPDATE decks SET status = 'failed' WHERE id = $1",
                uuid.UUID(deck_id),
            )
        except Exception:
            logger.exception("Failed to mark deck as failed in DB")

    finally:
        if close_db_conn and db_conn:
            await db_conn.close()
