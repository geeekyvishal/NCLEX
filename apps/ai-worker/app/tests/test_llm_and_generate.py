import pytest
from unittest.mock import MagicMock
from app.llm import _parse_retry_delay, LLMClient, LLMError
from app.generate import generate, draft_cards_for_chunk
from app.schemas import SourceChunk

def test_parse_retry_delay():
    # Test Gemini style error message containing retryDelay
    gemini_err = "Quota exceeded. ... {'retryDelay': '16s'}"
    assert _parse_retry_delay(Exception(gemini_err)) == 16.0

    # Test Gemini style with double quotes
    gemini_err_quotes = 'Quota exceeded. ... {"retryDelay": "20.5s"}'
    assert _parse_retry_delay(Exception(gemini_err_quotes)) == 20.5

    # Test openrouter style with header
    header_err = "Rate limit hit. Retry in 5s."
    assert _parse_retry_delay(Exception(header_err)) == 5.0

    # Test default fallback
    fallback_err = "General exception without delay info"
    assert _parse_retry_delay(Exception(fallback_err)) == 2.0

def test_generate_raises_if_all_fail():
    chunk = SourceChunk(id="c1", text="Sample nursing text", page_index=0, topic=None)
    mock_client = MagicMock()
    # Mock complete to raise an exception
    mock_client.chat.completions.create.side_effect = Exception("API rate limit error")

    llm_client = LLMClient(client=mock_client)

    with pytest.raises(RuntimeError) as exc_info:
        generate([chunk], client=llm_client)

    assert "Card generation failed for all chunks" in str(exc_info.value)
