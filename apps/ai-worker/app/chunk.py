"""Stage 2 (part a): Chunk.

Split parsed pages into semantic chunks (SourceChunk) with page numbers attached
for provenance.

The strategy is paragraph-aware: text is split on blank-line paragraph
boundaries, then paragraphs are packed greedily into chunks up to a target size
so a chunk stays semantically coherent and small enough to feed one generation
call.
Overlong single paragraphs are split on sentence boundaries as a fallback.
This is pure, deterministic logic so it is directly unit-testable.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from .parse import ParsedPage
from .schemas import SourceChunk

# Target and hard-cap chunk sizes in characters.
# Chunks aim for ~TARGET; a paragraph that would push a chunk past MAX starts a
# new chunk instead.
DEFAULT_TARGET_CHARS = 1200
DEFAULT_MAX_CHARS = 1800
# Chunks shorter than this are dropped as noise (page numbers, stray headers).
MIN_CHUNK_CHARS = 60

_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


@dataclass
class _Piece:
    """A paragraph plus the page it came from."""

    text: str
    page: int


def chunk_pages(
    pages: list[ParsedPage],
    *,
    target_chars: int = DEFAULT_TARGET_CHARS,
    max_chars: int = DEFAULT_MAX_CHARS,
    min_chars: int = MIN_CHUNK_CHARS,
) -> list[SourceChunk]:
    """Turn per-page text into semantic chunks with page provenance.

    A chunk's `page` is the page its first paragraph came from, which is the
    right anchor for citing a card back to its source.
    """
    pieces = _paragraphs(pages, max_chars)
    chunks: list[SourceChunk] = []

    buffer: list[str] = []
    buffer_len = 0
    buffer_page: int | None = None

    def flush() -> None:
        nonlocal buffer, buffer_len, buffer_page
        if buffer:
            text = "\n\n".join(buffer).strip()
            if len(text) >= min_chars:
                chunks.append(
                    SourceChunk(id=str(uuid.uuid4()), text=text, page=buffer_page, topic=None)
                )
            buffer = []
            buffer_len = 0
            buffer_page = None

    for piece in pieces:
        piece_len = len(piece.text)
        # Start a new chunk when adding this paragraph would exceed the target
        # and the buffer already holds content.
        if buffer and buffer_len + piece_len > target_chars:
            flush()
        if buffer_page is None:
            buffer_page = piece.page
        buffer.append(piece.text)
        buffer_len += piece_len + 2  # account for the joining blank line

    flush()
    return chunks


def _paragraphs(pages: list[ParsedPage], max_chars: int) -> list[_Piece]:
    """Split pages into paragraph-sized pieces, further splitting overlong ones."""
    pieces: list[_Piece] = []
    for page in pages:
        for para in page.text.split("\n\n"):
            para = para.strip()
            if not para:
                continue
            if len(para) <= max_chars:
                pieces.append(_Piece(text=para, page=page.page))
            else:
                for part in _split_long(para, max_chars):
                    pieces.append(_Piece(text=part, page=page.page))
    return pieces


def _split_long(para: str, max_chars: int) -> list[str]:
    """Split an overlong paragraph on sentence boundaries into <= max_chars parts."""
    sentences = _SENTENCE_RE.split(para)
    parts: list[str] = []
    current: list[str] = []
    current_len = 0
    for sentence in sentences:
        if current and current_len + len(sentence) > max_chars:
            parts.append(" ".join(current).strip())
            current = []
            current_len = 0
        current.append(sentence)
        current_len += len(sentence) + 1
    if current:
        parts.append(" ".join(current).strip())
    # A single sentence longer than max_chars is emitted whole rather than cut
    # mid-word; generation can still handle it.
    return [p for p in parts if p]
