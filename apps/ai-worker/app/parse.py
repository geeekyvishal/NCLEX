"""Stage 1: Parse and normalize.

Download the uploaded PDF from S3-compatible object storage by its storage key
and extract text per page with pypdf.

The S3 access is behind a small `download_pdf` seam so tests can supply bytes
without a live bucket. Text extraction returns one entry per page so downstream
chunking can attach accurate page numbers for provenance.
"""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from typing import Any, Protocol

from .config import settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ParsedPage:
    """Text extracted from a single PDF page. `page` is 1-indexed."""

    page: int
    text: str


class ObjectStore(Protocol):
    """Minimal object-storage seam. `boto3`'s S3 client satisfies this."""

    def get_object(self, *, Bucket: str, Key: str) -> Any:  # noqa: N803 - boto3 kwarg names
        ...


def _default_s3_client() -> Any:
    """Build a boto3 S3 client from settings (MinIO in dev, S3 in prod)."""
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
    )


def download_pdf(storage_key: str, *, store: ObjectStore | None = None) -> bytes:
    """Fetch the raw PDF bytes for `storage_key` from object storage."""
    client = store or _default_s3_client()
    response = client.get_object(Bucket=settings.s3_bucket, Key=storage_key)
    body = response["Body"]
    # boto3 returns a streaming body; a plain bytes source (tests) may not.
    return body.read() if hasattr(body, "read") else bytes(body)


def extract_pages(pdf_bytes: bytes) -> list[ParsedPage]:
    """Extract text per page from PDF bytes using pypdf.

    Pages that fail to extract yield empty text rather than aborting the whole
    document, so one malformed page never fails an otherwise good upload.
    """
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf_bytes))
    pages: list[ParsedPage] = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001 - one bad page must not fail the doc
            logger.warning("Failed to extract page %d: %s", index, exc)
            text = ""
        pages.append(ParsedPage(page=index, text=_normalize(text)))
    return pages


def parse(storage_key: str, *, store: ObjectStore | None = None) -> list[ParsedPage]:
    """Download and parse a PDF into per-page text. This is the stage entrypoint."""
    pdf_bytes = download_pdf(storage_key, store=store)
    pages = extract_pages(pdf_bytes)
    logger.info("Parsed %d pages from %s", len(pages), storage_key)
    return pages


def _normalize(text: str) -> str:
    """Collapse runs of whitespace while preserving paragraph breaks."""
    # Normalize line endings, collapse intra-line whitespace, keep blank lines
    # (blank lines mark paragraph boundaries the chunker relies on).
    lines = [" ".join(line.split()) for line in text.replace("\r\n", "\n").split("\n")]
    normalized = "\n".join(lines)
    # Collapse 3+ consecutive newlines into a paragraph break.
    while "\n\n\n" in normalized:
        normalized = normalized.replace("\n\n\n", "\n\n")
    return normalized.strip()
