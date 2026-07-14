"""Stage 5: Verify (separate pass).

A second, independent Claude call (GENERATION_MODEL) fact-checks each DraftCard
against the source chunk it came from, returning a VerifiedCard with a
confidence in 0..1 and an optional corrected back.

This is intentionally a SEPARATE model call from generation, not merged into it.
Per `04_ARCHITECTURE.md` section 5, the verification pass adversarially checks
each card, which catches errors a single generate-and-score pass would keep.
Low-confidence cards are not dropped here - they are surfaced to the user with a
marker (see LOW_CONFIDENCE_THRESHOLD); ranking (stage 6) decides what to keep.

To preserve provenance for the verifier, the source chunk text is supplied per
card via a lookup built from the chunks list.
"""
from __future__ import annotations

import logging

from .config import settings
from .llm import LLMClient, default_client
from .schemas import DraftCard, SourceChunk, VerifiedCard

logger = logging.getLogger(__name__)

_SYSTEM = """You are a meticulous NCLEX fact-checker reviewing a flashcard that another author drafted from a source passage.
Your job is adversarial verification, not rewriting for style.

For the card, decide:
- Is the answer factually correct and fully supported by the source passage?
- Is it clinically accurate for NCLEX (dose ranges, lab values, safety guidance)?

Then return:
- "confidence": a number from 0 to 1. Use high values (>0.8) only when the back is clearly correct and supported. Use low values (<0.6) when it is unsupported, ambiguous, or possibly wrong.
- "correctedBack": if the back has a factual error you can fix from the passage, provide the corrected back text. If the back is already correct, return null. Do not rewrite merely for wording.

Respond with JSON only: a single object with keys "confidence" and "correctedBack". Do not wrap the JSON in prose."""


def verify_card(
    card: DraftCard,
    source_text: str,
    *,
    client: LLMClient | None = None,
) -> VerifiedCard:
    """Fact-check a single draft card against its source text.

    On model or parse failure the card is returned with a low, conservative
    confidence and no correction, so a verifier outage degrades gracefully to
    "surface it, marked low-confidence" rather than dropping content.
    """
    llm = client or default_client
    user = (
        f"Source passage:\n{source_text}\n\n"
        f"Flashcard to verify:\n"
        f"Front: {card.front}\n"
        f"Back: {card.back}"
    )
    try:
        data = llm.complete_json(settings.generation_model, _SYSTEM, user, max_tokens=512)
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, do not fail the batch
        logger.warning("Verification failed for card from chunk %s: %s", card.source_chunk_id, exc)
        return _low_confidence(card)

    return _coerce_verified(data, card)


def verify(
    cards: list[DraftCard],
    chunks: list[SourceChunk],
    *,
    client: LLMClient | None = None,
) -> list[VerifiedCard]:
    """Verify every draft card. Stage entrypoint.

    `chunks` is used to recover each card's source text for grounded checking.
    """
    text_by_id = {chunk.id: chunk.text for chunk in chunks}
    verified: list[VerifiedCard] = []
    for card in cards:
        source_text = text_by_id.get(card.source_chunk_id, "")
        verified.append(verify_card(card, source_text, client=client))
    low = sum(1 for v in verified if v.confidence < 0.6)
    logger.info("Verified %d cards (%d below confidence threshold)", len(verified), low)
    return verified


def _coerce_verified(data: object, card: DraftCard) -> VerifiedCard:
    """Normalize the verifier's JSON into a VerifiedCard, clamping confidence."""
    confidence = 0.5
    corrected: str | None = None
    if isinstance(data, dict):
        raw_conf = data.get("confidence")
        try:
            confidence = float(raw_conf)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            confidence = 0.5
        confidence = max(0.0, min(1.0, confidence))
        raw_corrected = data.get("correctedBack") or data.get("corrected_back")
        if isinstance(raw_corrected, str) and raw_corrected.strip():
            corrected = raw_corrected.strip()
    return VerifiedCard(
        front=card.front,
        back=card.back,
        topic=card.topic,
        source_chunk_id=card.source_chunk_id,
        confidence=confidence,
        corrected_back=corrected,
    )


def _low_confidence(card: DraftCard) -> VerifiedCard:
    """Fallback VerifiedCard used when the verifier call cannot complete."""
    return VerifiedCard(
        front=card.front,
        back=card.back,
        topic=card.topic,
        source_chunk_id=card.source_chunk_id,
        confidence=0.3,
        corrected_back=None,
    )
