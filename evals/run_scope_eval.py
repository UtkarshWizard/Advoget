#!/usr/bin/env python3
"""Scope guard evaluation runner (Section 12.4 & Section 13).

Evaluates heuristics + LLM gate against evals/cases.jsonl.
Reports accuracy, false refusals (legal classified as not_legal), and leaks (not_legal classified as legal).
Checks OpenRouter's free-tier daily quota before running live calls so it stops cleanly with a clear
message when the 50/day cap is reached (Section 14).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
AI_SERVICE_DIR = REPO_ROOT / "ai-service"
sys.path.insert(0, str(AI_SERVICE_DIR))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(AI_SERVICE_DIR / ".env")

from app.config import settings  # noqa: E402
from app.llm import LLMRateLimitError  # noqa: E402
from app.scope import evaluate_scope  # noqa: E402


def load_cases(cases_path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for line in cases_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        cases.append(json.loads(stripped))
    return cases


def check_openrouter_daily_quota() -> dict[str, Any] | None:
    key = settings.openrouter_api_key.strip()
    if not key or "your-key" in key:
        return None
    try:
        resp = httpx.get(
            "https://openrouter.ai/api/v1/key",
            headers={"Authorization": f"Bearer {key}"},
            timeout=10.0,
        )
        if resp.status_code == 200:
            return resp.json().get("data", {}).get("free_model_daily_requests")
    except Exception:
        return None
    return None


async def evaluate_model_on_cases(
    model_id: str,
    cases: list[dict[str, Any]],
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    false_refusals: list[dict[str, Any]] = []
    leaks: list[dict[str, Any]] = []
    exact_matches = 0
    start_t = time.monotonic()

    for case in cases:
        case_id = case["id"]
        user_input = case["input"]
        history = case.get("history") or []
        has_doc = bool(case.get("has_doc", False))
        doc_preview = case.get("doc_preview")
        doc_previews = [doc_preview] if doc_preview else []
        expected = case["expect_scope"]

        try:
            res = await evaluate_scope(
                user_message=user_input,
                history=history,
                has_doc=has_doc,
                doc_previews=doc_previews,
                model_override=model_id,
                transport=transport,
            )
            actual = "legal" if res.label == "greeting" else res.label
            reason = res.reason
            source = res.source
        except LLMRateLimitError as exc:
            print(f"\n[!] Free-tier rate/quota limit reached on {model_id}: {exc.message}")
            print("Stopping immediately per SKILL.md Section 14 (never loop on rate-limit errors).")
            actual = "rate_limited"
            reason = exc.message[:80]
            source = "error"
            results.append(
                {
                    "id": case_id,
                    "expected": expected,
                    "actual": actual,
                    "matched": False,
                    "source": source,
                    "reason": reason,
                    "notes": case.get("notes", ""),
                }
            )
            break
        except Exception as exc:
            actual = "error"
            reason = str(exc)[:80]
            source = "error"

        matched = actual == expected
        if matched:
            exact_matches += 1

        entry = {
            "id": case_id,
            "expected": expected,
            "actual": actual,
            "matched": matched,
            "source": source,
            "reason": reason,
            "notes": case.get("notes", ""),
        }
        results.append(entry)

        if expected == "legal" and actual == "not_legal":
            false_refusals.append(entry)
        elif expected == "not_legal" and actual == "legal":
            leaks.append(entry)

    elapsed = time.monotonic() - start_t
    total = len(cases)
    accuracy = (exact_matches / total * 100.0) if total else 0.0

    return {
        "model": model_id,
        "total": total,
        "exact_matches": exact_matches,
        "accuracy": accuracy,
        "false_refusals": false_refusals,
        "leaks": leaks,
        "results": results,
        "elapsed_sec": elapsed,
    }


def print_model_report(summary: dict[str, Any]) -> None:
    print(f"\n=== Scope Eval Report: {summary['model']} ===")
    print(
        f"Accuracy: {summary['exact_matches']}/{summary['total']} ({summary['accuracy']:.1f}%) | "
        f"False Refusals: {len(summary['false_refusals'])} | "
        f"Leaks: {len(summary['leaks'])} | "
        f"Time: {summary['elapsed_sec']:.1f}s"
    )
    print(f"{'CASE ID':<16} {'EXPECTED':<11} {'ACTUAL':<11} {'SOURCE':<10} {'STATUS':<8} REASON")
    print("-" * 88)
    for r in summary["results"]:
        status_str = "PASS" if r["matched"] else "FAIL"
        print(
            f"{r['id']:<16} {r['expected']:<11} {r['actual']:<11} {r['source']:<10} {status_str:<8} {r['reason']}"
        )

    if summary["false_refusals"]:
        print("\n[!] FALSE REFUSALS (legal classified as not_legal):")
        for fr in summary["false_refusals"]:
            print(f"  - {fr['id']}: expected={fr['expected']} actual={fr['actual']} ({fr['reason']})")
    else:
        print("\n[OK] Zero false refusals on legal & borderline legal cases.")

    if summary["leaks"]:
        print("\n[!] LEAKS (not_legal classified as legal):")
        for lk in summary["leaks"]:
            print(f"  - {lk['id']}: expected={lk['expected']} actual={lk['actual']} ({lk['reason']})")
    else:
        print("[OK] Zero leaks on non-legal cases.")


def update_env_model_gate(env_path: Path, model_gate: str) -> None:
    if not env_path.exists():
        return
    content = env_path.read_text(encoding="utf-8")
    pattern = re.compile(r"^MODEL_GATE=.*$", re.MULTILINE)
    if pattern.search(content):
        content = pattern.sub(f"MODEL_GATE={model_gate}", content)
    else:
        content += f"\nMODEL_GATE={model_gate}\n"
    env_path.write_text(content, encoding="utf-8")


async def async_main() -> int:
    parser = argparse.ArgumentParser(description="Run Advoget V0 scope guard evaluation.")
    parser.add_argument(
        "--cases",
        type=Path,
        default=REPO_ROOT / "evals" / "cases.jsonl",
        help="Path to cases.jsonl",
    )
    parser.add_argument(
        "--models",
        type=str,
        default="",
        help="Comma-separated list of gate models to compare (defaults to configured MODEL_GATE)",
    )
    parser.add_argument(
        "--write-env",
        action="store_true",
        help="Update MODEL_GATE in ai-service/.env with the winning model",
    )
    args = parser.parse_args()

    quota = check_openrouter_daily_quota()
    if quota is not None:
        print(
            f"OpenRouter Free-Tier Daily Quota: used={quota.get('used')}/{quota.get('limit')} "
            f"(remaining={quota.get('remaining')})"
        )
        if int(quota.get("remaining") or 0) <= 0:
            print(
                "\n[!] OpenRouter free-tier daily limit (50 requests/day) has been reached for today. "
                "Add $10 credit once on OpenRouter to unlock 1,000 free requests/day, or wait for daily reset."
            )
            return 0

    cases = load_cases(args.cases)
    if args.models.strip():
        model_list = [m.strip() for m in args.models.split(",") if m.strip()]
    else:
        model_list = [settings.model_gate or settings.gate_models_list[0]]

    summaries: list[dict[str, Any]] = []
    for model_id in model_list:
        summary = await evaluate_model_on_cases(model_id, cases)
        print_model_report(summary)
        summaries.append(summary)

    if len(summaries) > 1:
        print("\n=== Top Gate Model Comparison Summary ===")
        print(f"{'MODEL ID':<45} {'ACCURACY':>10} {'FALSE REFUSALS':>16} {'LEAKS':>8} {'TIME':>8}")
        print("-" * 92)
        for s in summaries:
            print(
                f"{s['model']:<45} {s['accuracy']:>9.1f}% {len(s['false_refusals']):>16} {len(s['leaks']):>8} {s['elapsed_sec']:>7.1f}s"
            )

    summaries.sort(
        key=lambda s: (
            len(s["false_refusals"]),
            len(s["leaks"]),
            -s["accuracy"],
            s["elapsed_sec"],
        )
    )
    winner = summaries[0]
    print(
        f"\nSelected Best Gate Model: {winner['model']} "
        f"(Accuracy: {winner['accuracy']:.1f}%, False Refusals: {len(winner['false_refusals'])}, Leaks: {len(winner['leaks'])})"
    )

    if args.write_env:
        env_path = AI_SERVICE_DIR / ".env"
        update_env_model_gate(env_path, winner["model"])
        print(f"Updated MODEL_GATE={winner['model']} in {env_path}")

    if len(winner["false_refusals"]) > 0 or winner["accuracy"] < 90.0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(async_main()))
