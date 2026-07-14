"""Regeneration logic for flashcards.

Handles card-specific and deck-wide regeneration requests by calling LLM
to perform edits/additions/deletions, running adversarial verification,
persisting the changes to Postgres, and maintaining scheduling consistency
by resetting scheduling parameters and clearing review logs for edited/deleted cards.
"""
from __future__ import annotations

import json
import logging
import uuid
import inspect
from typing import Any

import asyncpg

from .config import settings
from .schemas import DraftCard, VerifiedCard, JobProgress, JobStage, MODEL_VERSION
from .llm import LLMClient, default_client
from .verify import verify_card

logger = logging.getLogger(__name__)


def _to_uuid(val: str | None) -> uuid.UUID | None:
    """Convert string to UUID or return None."""
    if not val:
        return None
    try:
        return uuid.UUID(val)
    except ValueError:
        return None


async def run_regeneration(
    request: Any,
    *,
    redis_client: Any = None,
    db_conn: asyncpg.Connection | None = None,
    llm_client: Any = None,
) -> None:
    """Orchestrator for card regeneration.

    Handles both card-specific (request.card_id is set) and deck-wide
    (request.card_id is not set) regeneration workflows.
    """
    # 1. Parse request fields flexibly (supports Pydantic objects or dicts)
    job_id = getattr(request, "job_id", None) or (request.get("job_id") if isinstance(request, dict) else None)
    deck_id = getattr(request, "deck_id", None) or (request.get("deck_id") if isinstance(request, dict) else None)
    source_id = getattr(request, "source_id", None) or (request.get("source_id") if isinstance(request, dict) else None)
    prompt = getattr(request, "prompt", None) or (request.get("prompt") if isinstance(request, dict) else "")
    card_id = getattr(request, "card_id", None) or (request.get("card_id") if isinstance(request, dict) else None)

    if not deck_id:
        raise ValueError("deck_id is required for regeneration")
    if not prompt:
        raise ValueError("prompt is required for regeneration")

    llm = llm_client or default_client

    close_db_conn = False
    if db_conn is None:
        db_conn = await asyncpg.connect(settings.database_url)
        close_db_conn = True

    async def publish_progress(stage: JobStage, progress: float, message: str | None = None) -> None:
        if not job_id:
            return
        logger.info(
            "Regen Job %s progress: stage=%s, progress=%f, msg=%s",
            job_id,
            stage.value,
            progress,
            message,
        )
        try:
            if redis_client:
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
        except Exception as exc:
            logger.warning("Failed to publish progress to Redis: %s", exc)

        try:
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
        except Exception as exc:
            logger.warning("Failed to update generation job status in DB: %s", exc)

    try:
        if card_id:
            # --- Card-specific edit workflow ---
            await publish_progress(JobStage.GENERATING, 0.2, "Fetching card and original passage...")
            
            # Fetch the card
            card_row = await db_conn.fetchrow(
                """
                SELECT id, deck_id, front, back, topic, confidence, source_chunk_id, model_version, flagged
                FROM cards
                WHERE id = $1
                """,
                uuid.UUID(card_id),
            )
            if not card_row:
                raise ValueError(f"Card with id {card_id} not found")

            # Fetch the source chunk text if present
            source_text = ""
            source_chunk_id = card_row["source_chunk_id"]
            if source_chunk_id:
                chunk_row = await db_conn.fetchrow(
                    "SELECT text FROM source_chunks WHERE id = $1",
                    source_chunk_id,
                )
                if chunk_row:
                    source_text = chunk_row["text"]

            await publish_progress(JobStage.GENERATING, 0.4, "Calling LLM to edit the card...")
            
            system_prompt = (
                "You are an expert NCLEX nurse educator.\n"
                "You are editing a flashcard based on a user's instruction and the original source passage it was generated from.\n\n"
                "Rules:\n"
                "- Make edits to the card strictly following the user's instruction and the source passage.\n"
                "- Keep the question tight and focused. The front must be a single clear question.\n"
                "- The answer must be correct, concise, and NCLEX-relevant. The back must be a concise answer.\n"
                "- Do not invent facts that are not supported by the source passage.\n"
                "- Keep the topic of the card consistent or improve it if needed.\n"
                "- Respond with JSON only: a single object with 'front', 'back', and optionally 'topic' keys. Do not wrap the JSON in prose."
            )
            user_prompt = (
                f"Original Card:\n"
                f"Front: {card_row['front']}\n"
                f"Back: {card_row['back']}\n"
                f"Topic: {card_row['topic'] or 'None'}\n\n"
                f"Source Passage:\n"
                f"{source_text}\n\n"
                f"User Instruction:\n"
                f"{prompt}"
            )
            
            data = llm.complete_json(settings.generation_model, system_prompt, user_prompt)
            if not isinstance(data, dict):
                raise ValueError("LLM did not return a JSON object")

            new_front = (data.get("front") or card_row["front"] or "").strip()
            new_back = (data.get("back") or card_row["back"] or "").strip()
            new_topic = data.get("topic") or card_row["topic"]

            await publish_progress(JobStage.VERIFYING, 0.7, "Running adversarial verification on edited card...")
            
            draft_card = DraftCard(
                front=new_front,
                back=new_back,
                topic=new_topic,
                source_chunk_id=str(source_chunk_id) if source_chunk_id else None,
            )
            verified = verify_card(draft_card, source_text, client=llm)

            await publish_progress(JobStage.PERSISTING, 0.9, "Updating card and clearing review logs...")
            
            changed = (new_front != card_row["front"]) or (verified.effective_back != card_row["back"])
            
            async with db_conn.transaction():
                if changed:
                    # Reset scheduling and clear review logs
                    await db_conn.execute(
                        """
                        UPDATE cards
                        SET front = $1, back = $2, topic = $3, confidence = $4, model_version = $5,
                            stability = 0.0, difficulty = 0.0, reps = 0, lapses = 0, state = 0, due = now(), last_review = NULL
                        WHERE id = $6
                        """,
                        verified.front,
                        verified.effective_back,
                        verified.topic,
                        verified.confidence,
                        MODEL_VERSION,
                        uuid.UUID(card_id),
                    )
                    await db_conn.execute(
                        "DELETE FROM reviews WHERE card_id = $1",
                        uuid.UUID(card_id),
                    )
                else:
                    # Keep scheduling, just update topic/confidence/model_version
                    await db_conn.execute(
                        """
                        UPDATE cards
                        SET topic = $1, confidence = $2, model_version = $3
                        WHERE id = $4
                        """,
                        verified.topic,
                        verified.confidence,
                        MODEL_VERSION,
                        uuid.UUID(card_id),
                    )

        else:
            # --- Deck-wide edit workflow ---
            await publish_progress(JobStage.GENERATING, 0.2, "Fetching deck cards and source passages...")
            
            # Fetch all current cards in the deck
            card_rows = await db_conn.fetch(
                """
                SELECT id, deck_id, front, back, topic, confidence, source_chunk_id, model_version, flagged
                FROM cards
                WHERE deck_id = $1
                """,
                uuid.UUID(deck_id),
            )
            
            # Fetch source_id if not supplied
            if not source_id:
                deck_row = await db_conn.fetchrow(
                    "SELECT source_id FROM decks WHERE id = $1",
                    uuid.UUID(deck_id),
                )
                if deck_row:
                    source_id = deck_row["source_id"]

            # Fetch all source chunks
            chunk_rows = []
            if source_id:
                chunk_rows = await db_conn.fetch(
                    "SELECT id, text, page, topic FROM source_chunks WHERE source_id = $1",
                    uuid.UUID(source_id),
                )

            current_cards_data = [
                {
                    "id": str(r["id"]),
                    "front": r["front"],
                    "back": r["back"],
                    "topic": r["topic"],
                    "source_chunk_id": str(r["source_chunk_id"]) if r["source_chunk_id"] else None,
                }
                for r in card_rows
            ]
            source_chunks_data = [
                {
                    "id": str(r["id"]),
                    "text": r["text"],
                    "page": r["page"],
                    "topic": r["topic"],
                }
                for r in chunk_rows
            ]

            await publish_progress(JobStage.GENERATING, 0.4, "Calling LLM to plan deck-wide edits...")
            
            system_prompt = (
                "You are an expert NCLEX nurse educator.\n"
                "You are performing a deck-wide edit of flashcards based on a user's instruction, the current cards in the deck, and the original source passages.\n\n"
                "You can decide to keep, edit, add, or delete cards:\n"
                "- 'keep': Keep the card exactly as is because it fits the user instruction and is accurate. No changes to front, back, or topic.\n"
                "- 'edit': Modify the card's front, back, or topic to align with the user instruction or correct errors.\n"
                "- 'add': Create a new flashcard from one of the source passages to address the user instruction.\n"
                "- 'delete': Remove the card because it does not fit the user instruction, is redundant, or is low quality.\n\n"
                "Rules:\n"
                "1. Respond with JSON only: an array of objects representing actions.\n"
                "2. Each object must have:\n"
                "   - 'action': 'keep' | 'edit' | 'add' | 'delete'\n"
                "   - 'card_id': string (the UUID of the original card, required for 'keep', 'edit', and 'delete'; set to null or omit for 'add')\n"
                "   - 'front': string (required for 'keep', 'edit', and 'add'; omit for 'delete')\n"
                "   - 'back': string (required for 'keep', 'edit', and 'add'; omit for 'delete')\n"
                "   - 'topic': string or null (for 'keep', 'edit', and 'add')\n"
                "   - 'source_chunk_id': string (the UUID of the source passage chunk this card is derived from, required for 'keep', 'edit', and 'add')\n"
                "3. Only add or edit cards based on facts that are clearly supported by the source passages.\n"
                "4. Keep cards tight, high-yield, and NCLEX-relevant.\n"
                "5. For EVERY card in the 'Current cards in the deck', you should return a corresponding action ('keep', 'edit', or 'delete'). If any card is not listed, it will be kept by default.\n"
                "6. Return JSON only. Do not wrap the JSON in prose."
            )
            user_prompt = (
                f"Current cards in the deck:\n"
                f"{json.dumps(current_cards_data, indent=2)}\n\n"
                f"Source passages (chunks) available:\n"
                f"{json.dumps(source_chunks_data, indent=2)}\n\n"
                f"User Instruction:\n"
                f"{prompt}"
            )
            
            actions_data = llm.complete_json(settings.generation_model, system_prompt, user_prompt)
            if not isinstance(actions_data, list):
                logger.warning("LLM did not return a list for deck-wide edit, got: %s", type(actions_data))
                actions_data = []

            await publish_progress(JobStage.VERIFYING, 0.6, "Verifying new/edited cards...")
            
            chunk_text_map = {str(r["id"]): r["text"] for r in chunk_rows}
            original_cards_map = {str(r["id"]): r for r in card_rows}

            verified_edits = {}
            verified_adds = []
            to_delete_ids = []

            for item in actions_data:
                action = item.get("action")
                if action == "edit":
                    card_id_str = item.get("card_id")
                    if not card_id_str or card_id_str not in original_cards_map:
                        continue
                    front = (item.get("front") or "").strip()
                    back = (item.get("back") or "").strip()
                    topic = item.get("topic") or original_cards_map[card_id_str]["topic"]
                    source_chunk_id = item.get("source_chunk_id") or original_cards_map[card_id_str]["source_chunk_id"]
                    if not front or not back:
                        continue
                    draft = DraftCard(
                        front=front,
                        back=back,
                        topic=topic,
                        source_chunk_id=str(source_chunk_id) if source_chunk_id else None,
                    )
                    source_text = chunk_text_map.get(str(source_chunk_id), "") if source_chunk_id else ""
                    verified_card = verify_card(draft, source_text, client=llm)
                    verified_edits[card_id_str] = verified_card

                elif action == "add":
                    front = (item.get("front") or "").strip()
                    back = (item.get("back") or "").strip()
                    topic = item.get("topic")
                    source_chunk_id = item.get("source_chunk_id")
                    if not front or not back:
                        continue
                    draft = DraftCard(
                        front=front,
                        back=back,
                        topic=topic,
                        source_chunk_id=str(source_chunk_id) if source_chunk_id else None,
                    )
                    source_text = chunk_text_map.get(str(source_chunk_id), "") if source_chunk_id else ""
                    verified_card = verify_card(draft, source_text, client=llm)
                    verified_adds.append(verified_card)

                elif action == "delete":
                    card_id_str = item.get("card_id")
                    if card_id_str and card_id_str in original_cards_map:
                        to_delete_ids.append(uuid.UUID(card_id_str))

            await publish_progress(JobStage.PERSISTING, 0.85, "Applying deck-wide updates to Postgres...")
            
            async with db_conn.transaction():
                # Delete removed cards and clear their review logs
                if to_delete_ids:
                    await db_conn.execute(
                        "DELETE FROM cards WHERE id = ANY($1)",
                        to_delete_ids,
                    )
                    await db_conn.execute(
                        "DELETE FROM reviews WHERE card_id = ANY($1)",
                        to_delete_ids,
                    )

                # Process edited cards
                for card_id_str, verified in verified_edits.items():
                    card_id = uuid.UUID(card_id_str)
                    orig = original_cards_map[card_id_str]
                    changed = (verified.front != orig["front"]) or (verified.effective_back != orig["back"])
                    if changed:
                        await db_conn.execute(
                            """
                            UPDATE cards
                            SET front = $1, back = $2, topic = $3, confidence = $4, model_version = $5,
                                stability = 0.0, difficulty = 0.0, reps = 0, lapses = 0, state = 0, due = now(), last_review = NULL
                            WHERE id = $6
                            """,
                            verified.front,
                            verified.effective_back,
                            verified.topic,
                            verified.confidence,
                            MODEL_VERSION,
                            card_id,
                        )
                        await db_conn.execute(
                            "DELETE FROM reviews WHERE card_id = $1",
                            card_id,
                        )
                    else:
                        await db_conn.execute(
                            """
                            UPDATE cards
                            SET topic = $1, confidence = $2, model_version = $3
                            WHERE id = $4
                            """,
                            verified.topic,
                            verified.confidence,
                            MODEL_VERSION,
                            card_id,
                        )

                # Insert newly added cards
                for verified in verified_adds:
                    new_card_id = uuid.uuid4()
                    await db_conn.execute(
                        """
                        INSERT INTO cards (id, deck_id, front, back, topic, confidence, source_chunk_id, model_version, flagged, stability, difficulty, reps, lapses, state, due, last_review)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, 0.0, 0.0, 0, 0, 0, now(), NULL)
                        """,
                        new_card_id,
                        uuid.UUID(deck_id),
                        verified.front,
                        verified.effective_back,
                        verified.topic,
                        verified.confidence,
                        _to_uuid(verified.source_chunk_id),
                        MODEL_VERSION,
                    )

                # Update card count
                await db_conn.execute(
                    """
                    UPDATE decks
                    SET card_count = (SELECT COUNT(*)::int FROM cards WHERE deck_id = $1)
                    WHERE id = $1
                    """,
                    uuid.UUID(deck_id),
                )

        await publish_progress(JobStage.DONE, 1.0, "Regeneration completed successfully.")

    except Exception as exc:
        logger.exception("Regeneration failed for job %s", job_id)
        try:
            await publish_progress(JobStage.FAILED, 1.0, str(exc))
        except Exception:
            logger.exception("Failed to publish error progress to DB/Redis")
        raise exc
    finally:
        if close_db_conn and db_conn:
            await db_conn.close()
