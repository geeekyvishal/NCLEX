import pytest
from unittest.mock import MagicMock, patch

from app.config import Settings
from app.embed import OpenAIEmbedder


def test_openai_embedder_no_api_key():
    with patch("app.embed.settings", Settings(openai_api_key=None)):
        embedder = OpenAIEmbedder(api_key=None)
        with pytest.raises(ValueError, match="OpenAI API key is required"):
            embedder.embed_texts(["hello"])


def test_openai_embedder_empty_texts():
    embedder = OpenAIEmbedder(api_key="fake-key")
    assert embedder.embed_texts([]) == []


@patch("httpx.Client")
def test_openai_embedder_success(mock_client_class):
    mock_client = MagicMock()
    mock_client_class.return_value.__enter__.return_value = mock_client
    
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "data": [
            {"index": 0, "embedding": [1.0, 0.0]},
            {"index": 1, "embedding": [0.0, 1.0]}
        ]
    }
    mock_client.post.return_value = mock_response

    embedder = OpenAIEmbedder(api_key="fake-key")
    result = embedder.embed_texts(["text1", "text2"])
    
    assert len(result) == 2
    assert result[0] == [1.0, 0.0]
    assert result[1] == [0.0, 1.0]
    
    mock_client.post.assert_called_once()
    args, kwargs = mock_client.post.call_args
    assert args[0] == "https://api.openai.com/v1/embeddings"
    assert kwargs["headers"]["Authorization"] == "Bearer fake-key"
    assert kwargs["json"]["input"] == ["text1", "text2"]
