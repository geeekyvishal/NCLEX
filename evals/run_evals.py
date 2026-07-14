#!/usr/bin/env python3
"""Card quality evaluation runner.

Runs PDF fixtures through the AI worker pipeline stages (parse, chunk, embed,
dedup, tag, generate, verify, rank) and evaluates quality thresholds:
- Card counts and yield
- Formatting constraints (front must end with "?")
- Conciseness (front <= 150 chars, back <= 200 chars)
- Clinical/keyword relevance (pharmacology, lab values, safety)
- Confidence scores (average >= 0.8, low-confidence rate <= 20%)

Supports live evaluation using Anthropic's API or offline simulation (mock mode).
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass
from typing import Any

# Add apps/ai-worker to Python path to import app modules
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../apps/ai-worker")))

from app.config import settings
from app.parse import extract_pages
from app.chunk import chunk_pages
from app.embed import HashingEmbedder, embed_texts
from app.dedup import dedup_chunks, tag_chunks
from app.generate import generate
from app.verify import verify
from app.rank import rank
from app.schemas import VerifiedCard

FIXTURES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "fixtures"))

# ----------------------------------------------------------------------------
# PDF Fixtures Content Definition
# ----------------------------------------------------------------------------
FIXTURES = {
    "pharmacology.pdf": {
        "text": (
            "Pharmacology Review: Warfarin (Coumadin)\n"
            "Warfarin is an oral anticoagulant medication used to prevent blood clots, "
            "deep vein thrombosis (DVT), and pulmonary embolism (PE). It works by inhibiting "
            "vitamin K-dependent clotting factors.\n"
            "Key Nursing Interventions:\n"
            "1. Monitor International Normalized Ratio (INR) regularly. The therapeutic range for most patients is 2.0 to 3.0.\n"
            "2. Monitor for signs of bleeding, including hematuria, epistaxis, melena, and petechiae.\n"
            "3. Educate the patient to maintain a consistent intake of foods high in Vitamin K (e.g., green leafy vegetables), "
            "as sudden changes can affect warfarin efficacy.\n"
            "4. The antidote for warfarin toxicity or overdose is Vitamin K (phytonadione)."
        ),
        "keywords": ["warfarin", "coumadin", "inr", "vitamin", "anticoagulant", "bleed"],
    },
    "lab_values.pdf": {
        "text": (
            "Critical Lab Values: Potassium (K+)\n"
            "Potassium is the primary intracellular cation, essential for maintaining electrical excitability in cardiac and neuromuscular cells.\n"
            "Normal Range:\n"
            "The normal serum potassium level is 3.5 to 5.0 mEq/L.\n"
            "Clinical Implications:\n"
            "1. Hypokalemia (potassium < 3.5 mEq/L) can cause muscle weakness, cardiac dysrhythmias (U waves, flat T waves), "
            "and increased risk of digoxin toxicity. Treatment includes oral or intravenous potassium replacement. Never give potassium IV push.\n"
            "2. Hyperkalemia (potassium > 5.0 mEq/L) can cause muscle twitching, flaccid paralysis, and life-threatening cardiac dysrhythmias "
            "(tall peaked T waves, prolonged PR interval). Treatment includes sodium polystyrene sulfonate (Kayexalate), insulin with dextrose, "
            "or calcium gluconate to stabilize the myocardium."
        ),
        "keywords": ["potassium", "range", "hypokalemia", "hyperkalemia", "meq"],
    },
    "maternity_safety.pdf": {
        "text": (
            "Maternal-Newborn Safety: Magnesium Sulfate\n"
            "Magnesium Sulfate is a central nervous system depressant used to prevent seizures in preeclampsia and eclampsia. "
            "It is also used as a tocolytic to stop preterm labor.\n"
            "Therapeutic Level:\n"
            "The therapeutic range is 4.0 to 7.0 mEq/L.\n"
            "Monitoring for Toxicity:\n"
            "Nurses must assess the client closely for signs of magnesium toxicity:\n"
            "1. Absent deep tendon reflexes (DTRs) is usually the first sign of toxicity.\n"
            "2. Respiratory rate less than 12 breaths per minute.\n"
            "3. Urinary output less than 30 mL/hour, which leads to magnesium accumulation.\n"
            "4. Severe hypotension or cardiac arrest.\n"
            "If toxicity is suspected, stop the infusion immediately and administer the antidote, Calcium Gluconate (10% solution, IV push)."
        ),
        "keywords": ["magnesium", "sulfate", "preeclampsia", "toxicity", "reflex", "calcium"],
    },
}

# ----------------------------------------------------------------------------
# PDF Generation Helper
# ----------------------------------------------------------------------------
def generate_pdf_bytes(text_content: str) -> bytes:
    """Generate minimal valid PDF bytes containing the text content.

    Allows test runs to proceed with actual PDF parsing without external files.
    """
    lines = text_content.strip().split("\n")
    stream_parts = ["BT", "/F1 12 Tf", "72 750 Td"]
    for line in lines:
        escaped_line = line.replace("(", "\\(").replace(")", "\\)")
        stream_parts.append(f"({escaped_line}) Tj")
        stream_parts.append("0 -15 Td")
    stream_parts.append("ET")
    stream_content = "\n".join(stream_parts)
    stream_bytes = stream_content.encode("utf-8")

    obj1 = b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
    obj2 = b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
    obj4_body = f"<< /Length {len(stream_bytes)} >>\nstream\n".encode("utf-8") + stream_bytes + b"\nendstream\n"
    obj4 = b"4 0 obj\n" + obj4_body + b"endobj\n"
    obj3 = b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>\nendobj\n"

    header = b"%PDF-1.4\n"
    offset0 = len(header)
    offset1 = offset0 + len(obj1)
    offset2 = offset1 + len(obj2)
    offset3 = offset2 + len(obj3)
    offset4 = offset3 + len(obj4)

    xref = f"xref\n0 5\n0000000000 65535 f \n{offset0:010d} 00000 n \n{offset1:010d} 00000 n \n{offset2:010d} 00000 n \n{offset3:010d} 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{offset4}\n%%EOF\n".encode("utf-8")
    return header + obj1 + obj2 + obj3 + obj4 + xref

def ensure_fixtures() -> None:
    """Create the fixtures directory and write PDF files if missing."""
    os.makedirs(FIXTURES_DIR, exist_ok=True)
    for name, data in FIXTURES.items():
        path = os.path.join(FIXTURES_DIR, name)
        if not os.path.exists(path):
            print(f"Generating fixture PDF: {name}")
            pdf_bytes = generate_pdf_bytes(data["text"])
            with open(path, "wb") as f:
                f.write(pdf_bytes)

# ----------------------------------------------------------------------------
# Mock LLM Client
# ----------------------------------------------------------------------------
class MockLLMClient:
    """Offline mock client simulating Claude responses for target fixtures.

    Allows full evaluation run in local environments or basic CI runs.
    """
    def complete(self, model: str, system: str, user: str, *, max_tokens: int = 2048) -> str:
        raise NotImplementedError("Evals pipeline uses complete_json")

    def complete_json(self, model: str, system: str, user: str, *, max_tokens: int = 2048) -> Any:
        user_lower = user.lower()
        system_lower = system.lower()

        # Check if fact checker verification stage (must check first because prompt contains 'flashcard')
        if "meticulous nclex fact-checker" in system_lower or "verify" in system_lower:
            return {
                "confidence": 0.95,
                "correctedBack": None
            }

        # Check if draft generation stage
        elif "expert nclex nurse educator" in system_lower or "flashcard" in system_lower:
            if "warfarin" in user_lower or "coumadin" in user_lower:
                return [
                    {
                        "front": "What is the primary therapeutic indication for warfarin?",
                        "back": "Warfarin is an oral anticoagulant used to prevent blood clots, deep vein thrombosis (DVT), and pulmonary embolism (PE)."
                    },
                    {
                        "front": "What lab value must be monitored for a patient on warfarin therapy, and what is its typical therapeutic range?",
                        "back": "International Normalized Ratio (INR); the therapeutic range is typically 2.0 to 3.0."
                    },
                    {
                        "front": "What educational instruction should the nurse give regarding diet for a patient taking warfarin?",
                        "back": "Maintain a consistent intake of foods high in Vitamin K (like green leafy vegetables) to avoid affecting warfarin efficacy."
                    },
                    {
                        "front": "What is the antidote for warfarin toxicity or overdose?",
                        "back": "Vitamin K (phytonadione)."
                    }
                ]
            elif "potassium" in user_lower:
                return [
                    {
                        "front": "What is the normal serum range for potassium?",
                        "back": "3.5 to 5.0 mEq/L."
                    },
                    {
                        "front": "What cardiac dysrhythmia features are associated with hypokalemia?",
                        "back": "U waves and flat T waves."
                    },
                    {
                        "front": "What cardiac dysrhythmia features are associated with hyperkalemia?",
                        "back": "Tall peaked T waves and prolonged PR interval."
                    },
                    {
                        "front": "What antidote/treatments can be administered to stabilize the myocardium in severe hyperkalemia?",
                        "back": "Calcium gluconate stabilizes the myocardium, while sodium polystyrene sulfonate (Kayexalate) or insulin with dextrose helps lower potassium levels."
                    }
                ]
            elif "magnesium" in user_lower or "preeclampsia" in user_lower:
                return [
                    {
                        "front": "What is the primary clinical indication for administering magnesium sulfate in a preeclamptic client?",
                        "back": "To prevent seizures (convulsions) in preeclampsia and eclampsia."
                    },
                    {
                        "front": "What is the therapeutic serum level range for magnesium sulfate?",
                        "back": "4.0 to 7.0 mEq/L."
                    },
                    {
                        "front": "What are the key clinical signs of magnesium sulfate toxicity that the nurse must monitor?",
                        "back": "Absent deep tendon reflexes (DTRs), respiratory rate less than 12 breaths/minute, urinary output less than 30 mL/hour, and severe hypotension."
                    },
                    {
                        "front": "What is the antidote for magnesium sulfate toxicity?",
                        "back": "Calcium Gluconate (10% solution, administered IV push)."
                    }
                ]
            else:
                return []

        return []


# ----------------------------------------------------------------------------
# Eval Logic
# ----------------------------------------------------------------------------
@dataclass
class EvalMetricResult:
    name: str
    status: bool
    expected: str
    actual: str

def run_evals(use_mock: bool) -> int:
    """Run pipeline stages on PDF fixtures and evaluate quality metrics."""
    ensure_fixtures()

    # Build LLM Client
    if use_mock:
        print("Using Mock LLM Client (offline mode)")
        llm_client: Any = MockLLMClient()
    else:
        print("Using Live Anthropic LLM Client")
        from app.llm import LLMClient
        llm_client = LLMClient()

    all_cards: list[VerifiedCard] = []
    fixture_results: dict[str, list[VerifiedCard]] = {}

    start_time = time.time()

    for name, config in FIXTURES.items():
        print(f"\nProcessing fixture: {name}...")
        path = os.path.join(FIXTURES_DIR, name)

        # 1. Parse
        with open(path, "rb") as f:
            pdf_bytes = f.read()
        pages = extract_pages(pdf_bytes)
        print(f"  - Parsed {len(pages)} pages")

        # 2. Chunk
        chunks = chunk_pages(pages)
        print(f"  - Generated {len(chunks)} chunks")
        if not chunks:
            print(f"Error: No text chunks extracted from {name}")
            return 1

        # 3. Embed & Dedup & Tag
        chunk_texts = [c.text for c in chunks]
        embedder = HashingEmbedder()
        embeddings = embed_texts(chunk_texts, embedder=embedder)
        kept_chunks, _ = dedup_chunks(chunks, embeddings)
        tag_chunks(kept_chunks)
        print(f"  - Deduplicated to {len(kept_chunks)} chunks")

        # 4. Generate
        drafts = generate(kept_chunks, client=llm_client)
        print(f"  - Generated {len(drafts)} draft cards")

        # 5. Verify
        verified = verify(drafts, kept_chunks, client=llm_client)
        print(f"  - Verified {len(verified)} cards")

        # 6. Rank
        kept_cards = rank(verified, target_card_count=25)
        print(f"  - Ranked & selected {len(kept_cards)} final cards")

        fixture_results[name] = kept_cards
        all_cards.extend(kept_cards)

    elapsed_time = time.time() - start_time
    print("\n" + "="*80)
    print("CARD QUALITY EVALUATION RESULTS")
    print("="*80)
    print(f"Total time elapsed: {elapsed_time:.2f} seconds")
    print(f"Total cards generated: {len(all_cards)}")

    # Compute Evaluation Metrics
    metrics: list[EvalMetricResult] = []

    # Threshold 1: Total Card Yield
    min_total_cards = 8
    total_ok = len(all_cards) >= min_total_cards
    metrics.append(EvalMetricResult(
        name="Minimum Total Card Yield",
        status=total_ok,
        expected=f">= {min_total_cards} cards",
        actual=f"{len(all_cards)} cards"
    ))

    # Threshold 2: Yield per Fixture
    per_fixture_ok = True
    min_per_fixture = 2
    actual_per_fixture_str = []
    for name in FIXTURES:
        count = len(fixture_results.get(name, []))
        actual_per_fixture_str.append(f"{name}: {count}")
        if count < min_per_fixture:
            per_fixture_ok = False
    metrics.append(EvalMetricResult(
        name="Minimum Yield Per Fixture",
        status=per_fixture_ok,
        expected=f">= {min_per_fixture} cards each",
        actual=", ".join(actual_per_fixture_str)
    ))

    # Threshold 3: Formatting & Integrity (Questions and Non-Empty)
    non_empty_ok = True
    question_ok = True
    fronts_set = set()
    no_duplicates_ok = True
    
    for card in all_cards:
        if not card.front.strip() or not card.effective_back.strip():
            non_empty_ok = False
        if not card.front.strip().endswith("?"):
            question_ok = False
        if card.front.strip() in fronts_set:
            no_duplicates_ok = False
        fronts_set.add(card.front.strip())

    metrics.append(EvalMetricResult(
        name="No Empty Cards (Front/Back)",
        status=non_empty_ok,
        expected="True",
        actual=str(non_empty_ok)
    ))
    metrics.append(EvalMetricResult(
        name="All Fronts End with '?'",
        status=question_ok,
        expected="True",
        actual=str(question_ok)
    ))
    metrics.append(EvalMetricResult(
        name="No Duplicate Card Questions",
        status=no_duplicates_ok,
        expected="True",
        actual=str(no_duplicates_ok)
    ))

    # Threshold 4: Conciseness
    length_ok = True
    max_front_len = 150
    max_back_len = 200
    longest_front = 0
    longest_back = 0
    
    for card in all_cards:
        longest_front = max(longest_front, len(card.front))
        longest_back = max(longest_back, len(card.effective_back))
        if len(card.front) > max_front_len or len(card.effective_back) > max_back_len:
            length_ok = False

    metrics.append(EvalMetricResult(
        name="Card Conciseness Limits",
        status=length_ok,
        expected=f"Front <= {max_front_len}, Back <= {max_back_len} chars",
        actual=f"Max front: {longest_front}, Max back: {longest_back} chars"
    ))

    # Threshold 5: Keyword Relevance
    relevance_ok = True
    relevance_details = []
    
    for name, config in FIXTURES.items():
        cards = fixture_results.get(name, [])
        keywords = config["keywords"]
        card_texts = " ".join([c.front + " " + c.effective_back for c in cards]).lower()
        
        found = [kw for kw in keywords if kw in card_texts]
        match_rate = len(found) / len(keywords)
        relevance_details.append(f"{name}: {match_rate*100:.0f}% ({len(found)}/{len(keywords)})")
        
        # Expecting at least 50% keyword coverage in generated cards
        if match_rate < 0.5:
            relevance_ok = False

    metrics.append(EvalMetricResult(
        name="Clinical Keyword Relevance",
        status=relevance_ok,
        expected=">= 50% coverage per fixture",
        actual=", ".join(relevance_details)
    ))

    # Threshold 6: Verification Confidence
    confidence_ok = True
    low_confidence_rate_ok = True
    
    if all_cards:
        avg_confidence = sum(c.confidence for c in all_cards) / len(all_cards)
        low_confidence_cards = sum(1 for c in all_cards if c.confidence < 0.6)
        low_confidence_rate = low_confidence_cards / len(all_cards)
    else:
        avg_confidence = 0.0
        low_confidence_rate = 1.0

    if avg_confidence < 0.8:
        confidence_ok = False
    if low_confidence_rate > 0.2:
        low_confidence_rate_ok = False

    metrics.append(EvalMetricResult(
        name="Average Verification Confidence",
        status=confidence_ok,
        expected=">= 0.8",
        actual=f"{avg_confidence:.2f}"
    ))
    metrics.append(EvalMetricResult(
        name="Low-Confidence Cards Rate",
        status=low_confidence_rate_ok,
        expected="<= 20% (< 0.6 confidence)",
        actual=f"{low_confidence_rate*100:.1f}% ({low_confidence_cards}/{len(all_cards)})"
    ))

    # Print Summary Table
    print("\n{:<35} | {:<8} | {:<30} | {:<20}".format("Metric Name", "Status", "Expected", "Actual"))
    print("-" * 105)
    
    all_passed = True
    for m in metrics:
        status_str = "PASS" if m.status else "FAIL"
        if not m.status:
            all_passed = False
        print("{:<35} | {:<8} | {:<30} | {:<20}".format(m.name, status_str, m.expected, m.actual))

    print("-" * 105)
    
    # Print Card Dump for inspection
    print("\nGenerated Cards Preview:")
    for name, cards in fixture_results.items():
        print(f"\n--- {name} ---")
        for i, card in enumerate(cards, 1):
            print(f"[{i}] Q: {card.front}")
            print(f"    A: {card.effective_back}")
            print(f"    Confidence: {card.confidence:.2f}" + (f" (Corrected)" if card.corrected_back else ""))

    if all_passed:
        print("\nSUCCESS: All card quality evaluations passed.")
        return 0
    else:
        print("\nFAILURE: One or more card quality evaluations failed.")
        return 1

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run card quality evaluations.")
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Force run in mock mode using simulated Claude responses."
    )
    args = parser.parse_args()

    # Default to mock if ANTHROPIC_API_KEY is not set
    force_mock = args.mock or not settings.anthropic_api_key
    if force_mock and not args.mock:
        print("ANTHROPIC_API_KEY environment variable not found. Defaulting to mock mode.")

    sys.exit(run_evals(force_mock))
