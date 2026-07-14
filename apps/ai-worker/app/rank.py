"""Stage 6: Rank.

Selects the best subset of cards up to the target card count. It prioritises
cards with higher verifier confidence while ensuring that cards are spread
across topics rather than letting one topic dominate.
"""
from __future__ import annotations

from collections import defaultdict

from .schemas import VerifiedCard


def rank(cards: list[VerifiedCard], target_card_count: int) -> list[VerifiedCard]:
    """Select up to `target_card_count` cards.

    Prioritises higher confidence cards and spreads them across topics.
    """
    if len(cards) <= target_card_count:
        return cards

    # Group cards by topic. Keep track of original index to restore order.
    # Store tuples of (original_index, card)
    by_topic: dict[str | None, list[tuple[int, VerifiedCard]]] = defaultdict(list)
    for idx, card in enumerate(cards):
        by_topic[card.topic].append((idx, card))

    # Within each topic, sort by confidence descending.
    for topic in by_topic:
        by_topic[topic].sort(key=lambda item: item[1].confidence, reverse=True)

    # Sort topics to be deterministic. Keep None topics last.
    sorted_topics = sorted(
        by_topic.keys(),
        key=lambda t: (t is None, t or "")
    )

    selected: list[tuple[int, VerifiedCard]] = []

    # Round-robin selection
    while len(selected) < target_card_count:
        added_in_round = False
        for topic in sorted_topics:
            if by_topic[topic]:
                selected.append(by_topic[topic].pop(0))
                added_in_round = True
                if len(selected) == target_card_count:
                    break
        if not added_in_round:
            break

    # Restore original ordering
    selected.sort(key=lambda item: item[0])

    return [item[1] for item in selected]
