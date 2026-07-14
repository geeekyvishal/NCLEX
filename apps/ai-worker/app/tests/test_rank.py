from app.rank import rank
from app.schemas import VerifiedCard


def test_rank_under_target():
    cards = [
        VerifiedCard(front="f1", back="b1", topic="Pharmacology", source_chunk_id="c1", confidence=0.8),
        VerifiedCard(front="f2", back="b2", topic="Lab Values", source_chunk_id="c2", confidence=0.9),
    ]
    # Under target count, should return all cards unchanged.
    res = rank(cards, target_card_count=5)
    assert len(res) == 2
    assert res == cards


def test_rank_prefer_confidence_and_topic_spread():
    cards = [
        # Topic A
        VerifiedCard(front="A1", back="b", topic="A", source_chunk_id="1", confidence=0.9),
        VerifiedCard(front="A2", back="b", topic="A", source_chunk_id="1", confidence=0.8),
        VerifiedCard(front="A3", back="b", topic="A", source_chunk_id="1", confidence=0.7),
        # Topic B
        VerifiedCard(front="B1", back="b", topic="B", source_chunk_id="2", confidence=0.85),
        VerifiedCard(front="B2", back="b", topic="B", source_chunk_id="2", confidence=0.6),
        # Topic None (sorted last)
        VerifiedCard(front="N1", back="b", topic=None, source_chunk_id="3", confidence=0.95),
    ]

    # Target card count is 3.
    # Grouped/Sorted by topic:
    # A: [A1(0.9), A2(0.8), A3(0.7)]
    # B: [B1(0.85), B2(0.6)]
    # None: [N1(0.95)]
    # Round robin:
    # Round 1:
    #  A: select A1
    #  B: select B1
    #  None: select N1
    # selected = [A1, B1, N1]. Target reached.
    # Restored to original index ordering: A1 (idx 0), B1 (idx 3), N1 (idx 5)
    res = rank(cards, target_card_count=3)
    assert len(res) == 3
    assert [c.front for c in res] == ["A1", "B1", "N1"]


def test_rank_higher_target():
    cards = [
        VerifiedCard(front="A1", back="b", topic="A", source_chunk_id="1", confidence=0.9),
        VerifiedCard(front="A2", back="b", topic="A", source_chunk_id="1", confidence=0.8),
        VerifiedCard(front="B1", back="b", topic="B", source_chunk_id="2", confidence=0.85),
    ]
    # target = 2.
    # A: [A1(0.9), A2(0.8)]
    # B: [B1(0.85)]
    # Round 1:
    #  A: select A1
    #  B: select B1
    # selected = [A1, B1]. Target reached.
    res = rank(cards, target_card_count=2)
    assert len(res) == 2
    assert [c.front for c in res] == ["A1", "B1"]
