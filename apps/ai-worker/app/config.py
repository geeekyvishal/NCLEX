"""Environment configuration for the AI worker.

All runtime configuration is read from the environment once at import time and
exposed through a single frozen `Settings` instance.
Keeping this in one module gives every stage a single, testable seam for config.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

try:
    # Loading a .env file is a convenience for local dev only.
    # It is optional so the module imports cleanly in CI and tests.
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover - dotenv is a dev convenience
    pass


def _get(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    """Immutable snapshot of the worker's environment configuration."""

    # --- Anthropic / models ---
    anthropic_api_key: str | None = field(default_factory=lambda: _get("ANTHROPIC_API_KEY"))
    openai_api_key: str | None = field(default_factory=lambda: _get("OPENAI_API_KEY"))
    generation_model: str = field(default_factory=lambda: _get("GENERATION_MODEL", "claude-opus-4-8"))
    classify_model: str = field(
        default_factory=lambda: _get("CLASSIFY_MODEL", "claude-haiku-4-5-20251001")
    )

    # --- Data stores ---
    database_url: str | None = field(
        default_factory=lambda: _get("DATABASE_URL", "postgres://nclex:nclex@localhost:5432/nclex")
    )
    redis_url: str = field(default_factory=lambda: _get("REDIS_URL", "redis://localhost:6379"))

    # --- Object storage (S3 / MinIO) ---
    s3_endpoint: str | None = field(default_factory=lambda: _get("S3_ENDPOINT"))
    s3_region: str = field(default_factory=lambda: _get("S3_REGION", "us-east-1"))
    s3_bucket: str = field(default_factory=lambda: _get("S3_BUCKET", "nclex-sources"))
    s3_access_key: str | None = field(default_factory=lambda: _get("S3_ACCESS_KEY"))
    s3_secret_key: str | None = field(default_factory=lambda: _get("S3_SECRET_KEY"))

    # --- Pipeline knobs ---
    embedding_dim: int = field(default_factory=lambda: int(_get("EMBEDDING_DIM", "1536")))
    # Chunks whose cosine similarity is at or above this are treated as duplicates.
    dedup_similarity_threshold: float = field(
        default_factory=lambda: float(_get("DEDUP_SIMILARITY_THRESHOLD", "0.92"))
    )
    # LLM call hardening.
    llm_timeout_seconds: float = field(
        default_factory=lambda: float(_get("LLM_TIMEOUT_SECONDS", "60"))
    )

    # --- Redis channels / keys (kept here so producers and consumers agree) ---
    job_queue_key: str = "job:generation:queue"
    job_progress_channel: str = "job:progress"


# A single shared settings instance. Import this, do not re-read os.environ elsewhere.
settings = Settings()
