from app.chunk import chunk_pages
from app.parse import ParsedPage


def test_chunk_pages_basic():
    pages = [
        ParsedPage(page=1, text="Hello world paragraph one.\n\nHello world paragraph two."),
        ParsedPage(page=2, text="Hello world paragraph three on page two."),
    ]
    chunks = chunk_pages(pages, target_chars=20, max_chars=150, min_chars=10)
    assert len(chunks) == 3
    assert chunks[0].page == 1
    assert chunks[0].text == "Hello world paragraph one."
    assert chunks[1].page == 1
    assert chunks[1].text == "Hello world paragraph two."
    assert chunks[2].page == 2
    assert chunks[2].text == "Hello world paragraph three on page two."


def test_chunk_pages_too_short():
    pages = [
        ParsedPage(page=1, text="short"),  # below min_chars
    ]
    chunks = chunk_pages(pages, target_chars=100, max_chars=150, min_chars=10)
    assert len(chunks) == 0


def test_chunk_pages_greedy_packing():
    pages = [
        ParsedPage(page=1, text="Para one.\n\nPara two.\n\nPara three."),
    ]
    # target_chars is 40. Para one (9) + Para two (9) + join (2) = 20 <= 40.
    # Adding Para three (11) + join (2) = 33 <= 40.
    # All three should pack into one chunk.
    chunks = chunk_pages(pages, target_chars=40, max_chars=100, min_chars=5)
    assert len(chunks) == 1
    assert chunks[0].text == "Para one.\n\nPara two.\n\nPara three."
