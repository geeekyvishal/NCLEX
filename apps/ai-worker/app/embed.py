"""Stage 2 (part b): Embed.

Produce embeddings for chunk texts behind a clean interface:

    embed_texts(list[str]) -> list[list[float]]   # each vector has EMBEDDING_DIM (1536) dims

The default implementation is a deterministic, hash-based fake so the pipeline
runs offline with no embedding provider. It is structured so a real provider
(OpenAI, Voyage, a local model, etc.) drops in by implementing `Embedder` and
passing it where `embed_texts` is called - the rest of the pipeline is agnostic
to which embedder produced the vectors.

The vectors are L2-normalized so cosine similarity in `dedup` reduces to a dot
product.
"""
from __future__ import annotations

import hashlib
import math
from typing import Protocol

from .config import settings


class Embedder(Protocol):
    """The embedding seam. A real provider implements this one method."""

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        ...


class HashingEmbedder:
    """Deterministic, provider-free embedder for offline runs and tests.

    Each text is hashed into a fixed-dimension vector. The same text always maps
    to the same vector, and similar-but-different texts map to different vectors,
    which is enough to exercise dedup and persistence end to end without a real
    embedding service. It is NOT semantically meaningful - swap in a real
    `Embedder` for production quality.
    """

    def __init__(self, dim: int | None = None) -> None:
        self.dim = dim or settings.embedding_dim

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        # Distribute token hashes across dimensions to give distinct texts
        # distinct, repeatable directions.
        tokens = text.lower().split() or [text.lower()]
        for token in tokens:
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            # Use the digest to pick a dimension and a signed weight.
            idx = int.from_bytes(digest[:4], "big") % self.dim
            sign = 1.0 if digest[4] & 1 else -1.0
            vec[idx] += sign
        return _normalize(vec)


def _normalize(vec: list[float]) -> list[float]:
    """L2-normalize a vector; a zero vector is returned unchanged."""
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0.0:
        return vec
    return [v / norm for v in vec]


class OpenAIEmbedder:
    """Real embedder using the OpenAI Embeddings API.

    Uses `text-embedding-3-small` by default and L2-normalizes the output.
    """

    def __init__(self, api_key: str | None = None, model: str = "text-embedding-3-small") -> None:
        self.api_key = api_key or settings.openai_api_key
        self.model = model

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not self.api_key:
            raise ValueError("OpenAI API key is required for OpenAIEmbedder")
        if not texts:
            return []

        import httpx

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "input": texts,
            "model": self.model,
        }
        timeout = getattr(settings, "llm_timeout_seconds", 60.0)

        last_exc: Exception | None = None
        for attempt in range(2):
            try:
                with httpx.Client(timeout=timeout) as client:
                    response = client.post(
                        "https://api.openai.com/v1/embeddings",
                        headers=headers,
                        json=payload,
                    )
                    response.raise_for_status()
                    data = response.json()

                raw_embeddings = [
                    item["embedding"]
                    for item in sorted(data["data"], key=lambda x: x["index"])
                ]
                return [_normalize(emb) for emb in raw_embeddings]
            except Exception as exc:
                last_exc = exc
                if attempt == 0:
                    import time
                    time.sleep(0.5)

        raise RuntimeError(f"OpenAI embedding call failed after retry: {last_exc}") from last_exc


# Default embedder used by the pipeline. Replace with a real provider by
# constructing the pipeline with a different Embedder.
default_embedder: Embedder
if settings.openai_api_key:
    default_embedder = OpenAIEmbedder()
else:
    default_embedder = HashingEmbedder()


def embed_texts(texts: list[str], *, embedder: Embedder | None = None) -> list[list[float]]:
    """Embed a batch of texts into EMBEDDING_DIM vectors. Stage entrypoint."""
    return (embedder or default_embedder).embed_texts(texts)
