"""Pydantic models mirroring the shared TypeScript domain contracts.

This is the Python side of a cross-language contract.
The source of truth is `packages/domain/src/index.ts`.
Field names that cross the wire (GenerationJobRequest, JobProgress) are emitted
as camelCase JSON to match the TypeScript API and clients, while Python code
uses snake_case attribute names.
Change a shape here only in lockstep with the TypeScript definitions.
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


# ----------------------------------------------------------------------------
# Shared constants (mirror the TS constants exactly)
# ----------------------------------------------------------------------------

# Identifies the model pair used for a card, stored on every persisted card so
# generations can be audited and regenerated when prompts or models change.
MODEL_VERSION = "claude-opus-4-8+haiku-4-5/v1"

# Cards at or below this verifier confidence are shown with a "verify this"
# marker in the UI rather than hidden.
LOW_CONFIDENCE_THRESHOLD = 0.6


def _to_camel(snake: str) -> str:
    """Convert a snake_case field name to camelCase for JSON serialization."""
    head, *tail = snake.split("_")
    return head + "".join(word.capitalize() for word in tail)


class _CamelModel(BaseModel):
    """Base model that serializes to camelCase but accepts either casing.

    `populate_by_name` lets Python construct with snake_case names, while the
    camelCase aliases keep the JSON payloads identical to the TS contracts.
    """

    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
    )


# ----------------------------------------------------------------------------
# Job lifecycle (API <-> AI worker contract)
# ----------------------------------------------------------------------------


class JobStage(str, Enum):
    """The ordered stages the worker moves a job through.

    Values match the TS `JobStage` enum so progress events are interpretable by
    the API and clients without translation.
    """

    QUEUED = "queued"
    PARSING = "parsing"
    CHUNKING = "chunking"
    GENERATING = "generating"
    VERIFYING = "verifying"
    RANKING = "ranking"
    PERSISTING = "persisting"
    DONE = "done"
    FAILED = "failed"


class GenerationJobRequest(_CamelModel):
    """Payload the API enqueues for the AI worker to process one upload."""

    job_id: str
    deck_id: str
    source_id: str
    storage_key: str
    # Soft cap - the ranker keeps "the cards that matter, not 200 to delete".
    target_card_count: int = 25


class JobProgress(_CamelModel):
    """Progress event streamed from worker -> API -> client over WebSocket."""

    job_id: str
    stage: JobStage
    # 0..1 overall progress for the client's progress bar.
    progress: float = Field(ge=0.0, le=1.0)
    message: str | None = None


# ----------------------------------------------------------------------------
# AI pipeline intermediate shapes (shared with the Python worker)
# ----------------------------------------------------------------------------


class SourceChunk(_CamelModel):
    """A semantic chunk of a parsed source, embedded for dedup and provenance."""

    id: str
    text: str
    page: int | None = None
    topic: str | None = None


class DraftCard(_CamelModel):
    """A draft card before verification."""

    front: str
    back: str
    topic: str | None = None
    source_chunk_id: str


class VerifiedCard(_CamelModel):
    """Output of the verification pass for a single draft card.

    Extends DraftCard with a confidence score and an optional corrected back.
    The original back is preserved on the DraftCard fields for audit.
    """

    front: str
    back: str
    topic: str | None = None
    source_chunk_id: str
    confidence: float = Field(ge=0.0, le=1.0)
    # The verifier may correct the back; keep the original `back` for audit.
    corrected_back: str | None = None

    @property
    def effective_back(self) -> str:
        """The back to persist: the correction when present, else the original."""
        return self.corrected_back if self.corrected_back else self.back
