"""Stage 3: Dedup and scope.

Two responsibilities from `04_ARCHITECTURE.md` section 5, stage [3]:
  1. Drop near-duplicate chunks using cosine similarity over their embeddings,
     so repeated content (slide headers, boilerplate) is not turned into
     multiple near-identical cards.
  2. Tag each surviving chunk with an NCLEX topic ("scope"). Tagging uses a
     lightweight heuristic by default, with a clean seam to swap in a Haiku
     classifier call (CLASSIFY_MODEL) without touching the dedup logic.

`cosine_similarity` is pure and unit-tested directly.
"""
from __future__ import annotations

import logging
from typing import Callable

from .config import settings
from .schemas import SourceChunk

logger = logging.getLogger(__name__)


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity of two equal-length vectors.

    Returns 0.0 if either vector is zero-length or all zeros. Not assuming the
    inputs are pre-normalized keeps this function correct for any embedder.
    """
    if len(a) != len(b) or not a:
        return 0.0
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for x, y in zip(a, b):
        dot += x * y
        norm_a += x * x
        norm_b += y * y
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a**0.5 * norm_b**0.5)


def dedup_chunks(
    chunks: list[SourceChunk],
    embeddings: list[list[float]],
    *,
    threshold: float | None = None,
) -> tuple[list[SourceChunk], list[list[float]]]:
    """Drop chunks that are near-duplicates of an already-kept chunk.

    Greedy: iterate in order and keep a chunk only if it is below `threshold`
    similarity to every chunk kept so far. Returns the kept chunks alongside
    their embeddings so callers keep the two lists aligned for persistence.
    """
    thr = settings.dedup_similarity_threshold if threshold is None else threshold
    kept_chunks: list[SourceChunk] = []
    kept_embeddings: list[list[float]] = []

    for chunk, emb in zip(chunks, embeddings):
        if any(cosine_similarity(emb, kept) >= thr for kept in kept_embeddings):
            logger.debug("Dropping near-duplicate chunk %s", chunk.id)
            continue
        kept_chunks.append(chunk)
        kept_embeddings.append(emb)

    logger.info("Dedup kept %d of %d chunks", len(kept_chunks), len(chunks))
    return kept_chunks, kept_embeddings


# ----------------------------------------------------------------------------
# Topic tagging (scope)
# ----------------------------------------------------------------------------

# Keyword heuristics mapping common NCLEX content areas. This is the cheap
# default; a Haiku classifier can replace it via the `tagger` seam below.
_TOPIC_KEYWORDS: dict[str, tuple[str, ...]] = {
    "Pharmacology": (
        "drug",
        "medication",
        "dose",
        "dosage",
        "mg",
        "adverse",
        "contraindicat",
        "antibiotic",
        "insulin",
        "anticoagulant",
        "opioid",
        "beta-block",
    ),
    "Lab Values": (
        "lab",
        "level",
        "serum",
        "potassium",
        "sodium",
        "hemoglobin",
        "wbc",
        "platelet",
        "inr",
        "creatinine",
        "glucose",
        "mmol",
        "meq",
    ),
    "Safety": (
        "safety",
        "fall",
        "infection control",
        "isolation",
        "precaution",
        "restraint",
        "error",
        "hazard",
    ),
    "Cardiovascular": ("cardiac", "heart", "blood pressure", "ecg", "arrhythmia", "hypertension"),
    "Respiratory": ("respiratory", "lung", "oxygen", "ventilat", "airway", "copd", "asthma"),
    "Maternal/Newborn": ("pregnan", "prenatal", "labor", "newborn", "fetal", "postpartum"),
}

TopicTagger = Callable[[str], str | None]


def heuristic_tag(text: str) -> str | None:
    """Assign an NCLEX topic by keyword frequency. Returns None if nothing matches."""
    lowered = text.lower()
    best_topic: str | None = None
    best_score = 0
    for topic, keywords in _TOPIC_KEYWORDS.items():
        score = sum(lowered.count(keyword) for keyword in keywords)
        if score > best_score:
            best_score = score
            best_topic = topic
    return best_topic


def make_model_tagger(llm_client=None) -> TopicTagger:
    """Return a tagger backed by the Haiku classifier (CLASSIFY_MODEL).

    This is the "clean seam for the model": pass the resulting tagger to
    `tag_chunks` to replace the heuristic without changing any other stage.
    Falls back to the heuristic if the model returns an unrecognized label.
    """
    from .llm import default_client

    client = llm_client or default_client
    labels = list(_TOPIC_KEYWORDS.keys())
    system = (
        "You are an NCLEX content classifier. "
        "Given a passage, respond with exactly one topic label from this list "
        f"and nothing else: {', '.join(labels)}. "
        "If none fit well, respond with the single word: General."
    )

    def tag(text: str) -> str | None:
        try:
            raw = client.complete(settings.classify_model, system, text[:2000], max_tokens=16)
        except Exception as exc:  # noqa: BLE001 - never let tagging fail the pipeline
            logger.warning("Model tagging failed, falling back to heuristic: %s", exc)
            return heuristic_tag(text)
        label = raw.strip().splitlines()[0].strip() if raw else ""
        if label in labels:
            return label
        if label.lower() == "general":
            return None
        return heuristic_tag(text)

    return tag


def tag_chunks(
    chunks: list[SourceChunk], *, tagger: TopicTagger = heuristic_tag
) -> list[SourceChunk]:
    """Attach a topic to each chunk in place and return the list.

    Defaults to the heuristic tagger. Pass `make_model_tagger()` to use Haiku.
    """
    for chunk in chunks:
        chunk.topic = tagger(chunk.text)
    return chunks
