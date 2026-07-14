"""Environment configuration for the AI worker.

All runtime configuration is read from the environment once at import time and
exposed through a single frozen `Settings` instance.
Keeping this in one module gives every stage a single, testable seam for config.

LLM provider selection
-----------------------
Set `LLM_PROVIDER` to one of:
  gemini      (default) - Google Gemini via OpenAI-compatible API
  openrouter            - OpenRouter.ai (Claude, GPT-4, Gemini, …)
  anthropic             - Anthropic direct OpenAI-compatible API

Then set the matching API key:
  GEMINI_API_KEY        for gemini
  OPENROUTER_API_KEY    for openrouter
  ANTHROPIC_API_KEY     for anthropic

Model names must match the provider's naming convention:
  gemini      -> gemini-2.0-flash, gemini-2.5-pro, …
  openrouter  -> anthropic/claude-opus-4-5, google/gemini-2.0-flash, …
  anthropic   -> claude-opus-4-5, claude-3-haiku-20240307, …
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

    # --- LLM provider selection ---
    # Valid values: "gemini" (default), "openrouter", "anthropic"
    llm_provider: str = field(default_factory=lambda: _get("LLM_PROVIDER", "gemini"))

    # --- API keys (one per provider) ---
    gemini_api_key: str | None = field(default_factory=lambda: _get("GEMINI_API_KEY"))
    openrouter_api_key: str | None = field(default_factory=lambda: _get("OPENROUTER_API_KEY"))
    # Kept for backwards-compat and for the "anthropic" provider mode.
    anthropic_api_key: str | None = field(default_factory=lambda: _get("ANTHROPIC_API_KEY"))

    # --- OpenAI embeddings (optional, for vector search) ---
    openai_api_key: str | None = field(default_factory=lambda: _get("OPENAI_API_KEY"))

    # --- Model tiers ---
    # "Heavy" model for card generation and adversarial verification.
    generation_model: str = field(
        default_factory=lambda: _get("GENERATION_MODEL", "gemini-2.0-flash")
    )
    # "Cheap" model for high-volume classification tasks (dedup tagging, etc.).
    classify_model: str = field(
        default_factory=lambda: _get("CLASSIFY_MODEL", "gemini-2.0-flash")
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
