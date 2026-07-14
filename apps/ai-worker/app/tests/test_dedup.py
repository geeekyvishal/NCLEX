from app.dedup import cosine_similarity, dedup_chunks, heuristic_tag
from app.schemas import SourceChunk


def test_cosine_similarity():
    # Exact match
    assert cosine_similarity([1.0, 0.0], [1.0, 0.0]) == 1.0
    # Orthogonal
    assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == 0.0
    # Opposite
    assert cosine_similarity([1.0, 0.0], [-1.0, 0.0]) == -1.0
    # Zero vector
    assert cosine_similarity([0.0, 0.0], [1.0, 0.0]) == 0.0


def test_dedup_chunks():
    chunks = [
        SourceChunk(id="1", text="pharmacology notes", page=1),
        SourceChunk(id="2", text="pharmacology notes", page=2),  # exact duplicate text and embedding
        SourceChunk(id="3", text="respiratory notes", page=3),   # distinct
    ]
    # In hashing embedder, duplicate text will have identical embedding vector
    embeddings = [
        [1.0, 0.0],
        [1.0, 0.0],
        [0.0, 1.0],
    ]
    kept_chunks, kept_embeddings = dedup_chunks(chunks, embeddings, threshold=0.9)
    assert len(kept_chunks) == 2
    assert kept_chunks[0].id == "1"
    assert kept_chunks[1].id == "3"
    assert len(kept_embeddings) == 2
    assert kept_embeddings[0] == [1.0, 0.0]
    assert kept_embeddings[1] == [0.0, 1.0]


def test_heuristic_tag():
    text_pharma = "This patient was prescribed a high dose of insulin drug."
    assert heuristic_tag(text_pharma) == "Pharmacology"

    text_labs = "The lab level of serum potassium was high."
    assert heuristic_tag(text_labs) == "Lab Values"

    text_none = "Just a general statement about patient comfort."
    assert heuristic_tag(text_none) is None
