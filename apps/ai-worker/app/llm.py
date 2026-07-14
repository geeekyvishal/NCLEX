"""Thin Anthropic client wrapper.

Every Claude call in the pipeline goes through this module so that:
  - tests can mock a single, small surface (`LLMClient.complete` / `.complete_json`);
  - the exact Anthropic SDK call lives in one place and is easy to adjust;
  - timeouts and a single retry are applied uniformly and defensively.

The pipeline uses two models (see `04_ARCHITECTURE.md` section 5, "Model tiering"):
  - GENERATION_MODEL (claude-opus-4-8) for generation and verification;
  - CLASSIFY_MODEL  (claude-haiku-4-5-20251001) for cheap high-volume classification.

The call is deliberately minimal (model, max_tokens, system, messages) so it
stays compatible across Anthropic SDK revisions.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from .config import settings

logger = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """Raised when a Claude call fails after the retry budget is exhausted."""


class LLMClient:
    """Wraps the Anthropic Messages API behind `complete` / `complete_json`.

    Construction is lazy: the underlying SDK client is only built on first use,
    so importing this module (and the pipeline) never requires an API key.
    Tests substitute a fake client via the `client` argument or by monkeypatching
    `complete` / `complete_json`.
    """

    def __init__(self, client: Any | None = None) -> None:
        self._client = client

    def _ensure_client(self) -> Any:
        if self._client is None:
            # Imported lazily so the module imports without the anthropic package
            # or an API key present (needed for offline unit tests).
            import anthropic

            self._client = anthropic.Anthropic(
                api_key=settings.anthropic_api_key,
                timeout=settings.llm_timeout_seconds,
                max_retries=0,  # We manage retries ourselves for uniform behavior.
            )
        return self._client

    def complete(
        self,
        model: str,
        system: str,
        user: str,
        *,
        max_tokens: int = 2048,
    ) -> str:
        """Return the concatenated text of Claude's response as a plain string.

        Applies one retry on failure. The call is isolated here so the exact
        Messages API parameters can be adjusted without touching the pipeline.
        """
        client = self._ensure_client()
        last_error: Exception | None = None

        for attempt in range(2):  # initial try + one retry
            try:
                message = client.messages.create(
                    model=model,
                    max_tokens=max_tokens,
                    system=system,
                    messages=[{"role": "user", "content": user}],
                )
                return _extract_text(message)
            except Exception as exc:  # noqa: BLE001 - normalize to LLMError below
                last_error = exc
                logger.warning(
                    "LLM call failed (attempt %d/2) for model %s: %s",
                    attempt + 1,
                    model,
                    exc,
                )
                if attempt == 0:
                    time.sleep(0.5)  # brief backoff before the single retry

        raise LLMError(f"Claude call failed after retry: {last_error}") from last_error

    def complete_json(
        self,
        model: str,
        system: str,
        user: str,
        *,
        max_tokens: int = 2048,
    ) -> Any:
        """Like `complete`, but parse the response as JSON.

        The prompt is expected to instruct the model to return JSON only.
        A tolerant extraction handles stray prose or code fences around the JSON.
        """
        raw = self.complete(model, system, user, max_tokens=max_tokens)
        return _parse_json(raw)


def _extract_text(message: Any) -> str:
    """Join all text blocks of an Anthropic Messages response into one string."""
    content = getattr(message, "content", None)
    if content is None:
        return ""
    parts: list[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
            text = block.get("text")
        if text:
            parts.append(text)
    return "".join(parts)


_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def _parse_json(raw: str) -> Any:
    """Parse JSON from a model response, tolerating code fences and surrounding text."""
    text = raw.strip()
    if not text:
        raise LLMError("Empty response where JSON was expected")

    # Prefer a fenced block if present.
    fence = _FENCE_RE.search(text)
    if fence:
        text = fence.group(1).strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Fall back to the first balanced JSON array or object in the text.
    snippet = _first_json_span(text)
    if snippet is not None:
        try:
            return json.loads(snippet)
        except json.JSONDecodeError as exc:
            raise LLMError(f"Could not parse JSON from response: {exc}") from exc

    raise LLMError("No JSON object or array found in response")


def _first_json_span(text: str) -> str | None:
    """Return the substring spanning the first balanced [...] or {...}, if any."""
    starts = {"[": "]", "{": "}"}
    for i, ch in enumerate(text):
        if ch in starts:
            closing = starts[ch]
            depth = 0
            in_str = False
            escaped = False
            for j in range(i, len(text)):
                c = text[j]
                if in_str:
                    if escaped:
                        escaped = False
                    elif c == "\\":
                        escaped = True
                    elif c == '"':
                        in_str = False
                    continue
                if c == '"':
                    in_str = True
                elif c == ch:
                    depth += 1
                elif c == closing:
                    depth -= 1
                    if depth == 0:
                        return text[i : j + 1]
            return None
    return None


# A shared default client for the pipeline. Tests pass their own instance.
default_client = LLMClient()
