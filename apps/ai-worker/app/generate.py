"""Stage 4: Generate.

For each source chunk, call Claude (GENERATION_MODEL) to draft flashcards
(DraftCard). This pass optimizes for coverage of accurate, non-bloated NCLEX
content - pharmacology, lab values, and safety in particular.

Generation is deliberately separate from verification (stage 5). This module
only drafts cards; it never assigns confidence. See `verify.py` for the
adversarial fact-checking pass, which is a core design requirement of the
pipeline (`04_ARCHITECTURE.md` section 5: "Generation and verification are
separate model calls").
"""
from __future__ import annotations

import logging

from .config import settings
from .llm import LLMClient, default_client
from .schemas import DraftCard, SourceChunk

logger = logging.getLogger(__name__)

_SYSTEM = """You are an expert NCLEX nurse educator writing flashcards.
You turn a passage of study material into a small set of high-yield, exam-relevant flashcards.

Rules:
- Only create cards for facts that are clearly supported by the passage. Never invent content.
- Prefer testable, high-yield NCLEX facts: pharmacology (drugs, doses, adverse effects, contraindications), lab values and their normal ranges, and patient safety.
- Keep each card tight. The front is a single clear question. The back is a concise, correct answer - no filler, no restating the question.
- Do not create trivial, duplicate, or overly broad cards. Quality over quantity: it is fine to return few cards, or an empty list, for a thin passage.
- Return at most 4 cards for a single passage.

Respond with JSON only: an array of objects, each with "front" and "back" string fields.
Return [] if the passage has no high-yield content. Do not wrap the JSON in prose."""


def draft_cards_for_chunk(
    chunk: SourceChunk,
    *,
    client: LLMClient | None = None,
    max_cards: int = 4,
) -> list[DraftCard]:
    """Draft flashcards for one chunk. Returns [] on model or parse failure.

    A single chunk that fails to generate must not fail the whole document, so
    errors are swallowed and logged - the pipeline continues with the rest.
    """
    llm = client or default_client
    user = (
        f"Passage topic hint: {chunk.topic or 'unspecified'}\n\n"
        f"Passage:\n{chunk.text}"
    )
    try:
        data = llm.complete_json(settings.generation_model, _SYSTEM, user, max_tokens=1536)
    except Exception as exc:  # noqa: BLE001 - one chunk failing is not fatal
        logger.warning("Generation failed for chunk %s: %s", chunk.id, exc)
        return []

    return _coerce_cards(data, chunk, max_cards)


def generate(
    chunks: list[SourceChunk],
    *,
    client: LLMClient | None = None,
) -> list[DraftCard]:
    """Draft cards across all chunks. Stage entrypoint."""
    drafts: list[DraftCard] = []
    for chunk in chunks:
        drafts.extend(draft_cards_for_chunk(chunk, client=client))
    logger.info("Generated %d draft cards from %d chunks", len(drafts), len(chunks))
    return drafts


def _coerce_cards(data: object, chunk: SourceChunk, max_cards: int) -> list[DraftCard]:
    """Validate and normalize the model's JSON into DraftCard objects."""
    if not isinstance(data, list):
        logger.warning("Expected a JSON array for chunk %s, got %s", chunk.id, type(data))
        return []
    cards: list[DraftCard] = []
    for item in data[:max_cards]:
        if not isinstance(item, dict):
            continue
        front = str(item.get("front", "")).strip()
        back = str(item.get("back", "")).strip()
        if not front or not back:
            continue
        cards.append(
            DraftCard(
                front=front,
                back=back,
                topic=chunk.topic,
                source_chunk_id=chunk.id,
            )
        )
    return cards
