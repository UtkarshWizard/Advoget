"""Milestone 4 tests for Scope Guard: heuristics, LLM gate, and full 24-case eval suite."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.scope import evaluate_scope, run_scope_heuristics
from evals.run_scope_eval import evaluate_model_on_cases, load_cases, print_model_report


def create_mock_gate_transport() -> httpx.MockTransport:
    """Mock transport simulating baidu/ernie-5.5-flash-preview:free responses for LLM-gated cases."""

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        user_prompt: str = body["messages"][-1]["content"].lower()

        if "<document_preview>" in user_prompt and "biryani" in user_prompt:
            out = {"label": "not_legal", "language": "en", "reason": "non-legal document: cooking recipe"}
        elif "conversation_history" in user_prompt and "what should i do next" in user_prompt:
            out = {"label": "legal", "language": "en", "reason": "follow-up on FIR legal turn"}
        elif "landlord" in user_prompt or "deposit" in user_prompt:
            out = {"label": "legal", "language": "en", "reason": "tenancy deposit dispute"}
        elif "meri bike" in user_prompt or "utha li" in user_prompt:
            out = {"label": "legal", "language": "hinglish", "reason": "vehicle seizure by police"}
        elif "employer" in user_prompt or "salary" in user_prompt:
            out = {"label": "legal", "language": "en", "reason": "labour law salary deduction"}
        elif "live-in relationship" in user_prompt:
            out = {"label": "legal", "language": "en", "reason": "family law legality question"}
        elif "python script" in user_prompt or "biryani" in user_prompt or "joke" in user_prompt or "cricket" in user_prompt:
            out = {"label": "not_legal", "language": "en", "reason": "off-topic non-legal request"}
        elif "can i do it?" in user_prompt or "neighbour problem" in user_prompt:
            out = {"label": "unclear", "language": "en", "reason": "vague issue with no details"}
        else:
            out = {"label": "legal", "language": "en", "reason": "legal query"}

        return httpx.Response(
            200,
            json={
                "model": body["model"],
                "choices": [{"message": {"role": "assistant", "content": json.dumps(out)}}],
            },
        )

    return httpx.MockTransport(handler)


async def run_tests() -> None:
    print("1. Testing deterministic heuristics (0 LLM calls)...")
    # Empty
    h_empty = run_scope_heuristics("   ")
    assert h_empty is not None and h_empty.label == "not_legal" and h_empty.llm_calls == 0

    # Over 4000 chars
    h_long = run_scope_heuristics("Legal question " * 300)
    assert h_long is not None and h_long.label == "not_legal" and h_long.llm_calls == 0

    # No letters
    h_dots = run_scope_heuristics(".....")
    assert h_dots is not None and h_dots.label == "not_legal" and h_dots.llm_calls == 0

    # Keyboard mash
    h_mash = run_scope_heuristics("asdfghjkl")
    assert h_mash is not None and h_mash.label == "not_legal" and h_mash.llm_calls == 0

    # Plain greetings (en, hinglish, hi) -> welcome message, not refusal
    h_hi = run_scope_heuristics("hi")
    assert h_hi is not None and h_hi.label == "greeting" and "FIR" in (h_hi.response_message or "")
    h_namaste = run_scope_heuristics("Namaste!")
    assert h_namaste is not None and h_namaste.label == "greeting" and h_namaste.language == "hinglish"
    h_dev = run_scope_heuristics("नमस्ते")
    assert h_dev is not None and h_dev.label == "greeting" and h_dev.language == "hi"

    # Wrongdoing -> refusal explaining lawful rights
    h_forge = run_scope_heuristics("How do I forge a land document?")
    assert h_forge is not None and h_forge.label == "not_legal"
    assert "lawful rights" in (h_forge.response_message or "")

    print("2. Running full 24-case evaluation suite (evals/cases.jsonl)...")
    cases_path = Path(__file__).resolve().parent.parent / "evals" / "cases.jsonl"
    cases = load_cases(cases_path)
    transport = create_mock_gate_transport()
    summary = await evaluate_model_on_cases(
        model_id="baidu/ernie-5.5-flash-preview:free",
        cases=cases,
        transport=transport,
    )
    print_model_report(summary)
    assert summary["exact_matches"] == 24, f"Expected 24/24, got {summary['exact_matches']}"
    assert len(summary["false_refusals"]) == 0, "Expected 0 false refusals"
    assert len(summary["leaks"]) == 0, "Expected 0 leaks"
    print("\nALL MILESTONE 4 AI-SERVICE SCOPE GUARD TESTS PASSED (24/24)!")


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    asyncio.run(run_tests())
