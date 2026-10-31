#!/usr/bin/env python3
"""Query OpenRouter's models API for free (:free) models supporting tool calling.

Lists models with their context length, provider, and endpoint uptime/availability,
and outputs recommended values for MODEL_GATE, MODEL_CHAT, and MODEL_FALLBACKS.
Can optionally update ai-service/.env with --write-env.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
OPENROUTER_ENDPOINTS_URL = "https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints"


def fetch_openrouter_models(api_key: str | None = None) -> list[dict[str, Any]]:
    headers: dict[str, str] = {"Accept": "application/json"}
    if api_key and "your-key" not in api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    with httpx.Client(timeout=20.0) as client:
        resp = client.get(OPENROUTER_MODELS_URL, headers=headers)
        resp.raise_for_status()
        payload = resp.json()
        return payload.get("data", [])


def fetch_model_uptime(client: httpx.Client, model_id: str) -> float | None:
    """Query OpenRouter's model endpoints API for the best endpoint uptime %."""
    base_id = model_id.removesuffix(":free")
    parts = base_id.split("/", 1)
    if len(parts) != 2:
        return None
    author, slug = parts[0], parts[1]
    url = OPENROUTER_ENDPOINTS_URL.format(author=author, slug=slug)
    try:
        resp = client.get(url, timeout=8.0)
        if resp.status_code != 200:
            return None
        endpoints = resp.json().get("data", {}).get("endpoints", [])
        uptimes = [
            float(ep["uptime_last_30m"])
            for ep in endpoints
            if ep.get("uptime_last_30m") is not None
        ]
        return max(uptimes) if uptimes else None
    except Exception:
        return None


def is_free_model(model: dict[str, Any]) -> bool:
    model_id: str = model.get("id", "")
    if not model_id.endswith(":free"):
        return False
    pricing = model.get("pricing") or {}
    try:
        prompt_cost = float(pricing.get("prompt", "0") or 0)
        completion_cost = float(pricing.get("completion", "0") or 0)
        return prompt_cost == 0.0 and completion_cost == 0.0
    except (ValueError, TypeError):
        return True


def supports_tool_calling(model: dict[str, Any]) -> bool:
    supported = set(model.get("supported_parameters") or [])
    return "tools" in supported and ("tool_choice" in supported or "tools" in supported)


def estimate_param_billions(model_id: str, name: str) -> float:
    """Heuristic parameter count in billions for sorting smallest/fastest vs strongest."""
    text = f"{model_id} {name}".lower()
    # Match patterns like 70b, 32b, 27b, 24b, 14b, 12b, 9b, 8b, 7b, 4b, 3b, 1.5b
    matches = re.findall(r"\b(\d+(?:\.\d+)?)b\b", text)
    if matches:
        return max(float(m) for m in matches)
    if "mini" in text or "flash" in text or "small" in text or "nano" in text:
        return 8.0
    if "large" in text or "pro" in text:
        return 70.0
    return 30.0


def pick_recommendations(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    eligible_32k = [c for c in candidates if c["context_length"] >= 32000]
    pool = eligible_32k if eligible_32k else candidates

    # Sort for gate: smallest/fastest model (4B - 14B preferred) with high uptime & structured output support
    gate_sorted = sorted(
        pool,
        key=lambda c: (
            0 if 3.0 <= c["params_b"] <= 16.0 else 1,
            0 if c["supports_structured"] else 1,
            -(c["uptime"] or 0.0),
            c["params_b"],
        ),
    )
    gate_top3 = [c["id"] for c in gate_sorted[:3]]
    model_gate = gate_top3[0] if gate_top3 else ""

    # Sort for chat: strongest tool-capable free model with >= 32K context and high uptime
    chat_sorted = sorted(
        eligible_32k or pool,
        key=lambda c: (
            -(1 if (c["uptime"] or 100.0) >= 80.0 else 0),
            -c["params_b"],
            -c["context_length"],
            -(c["uptime"] or 0.0),
        ),
    )

    model_chat = chat_sorted[0]["id"] if chat_sorted else ""
    chat_provider = model_chat.split("/")[0] if model_chat else ""

    # Pick 2 fallbacks from different providers, then append openrouter/free last for chat only
    fallbacks: list[str] = []
    seen_providers = {chat_provider}
    for cand in chat_sorted[1:]:
        provider = cand["id"].split("/")[0]
        if provider not in seen_providers and cand["id"] != model_chat:
            fallbacks.append(cand["id"])
            seen_providers.add(provider)
            if len(fallbacks) == 2:
                break

    # If fewer than 2 distinct providers available, fill with next best distinct models
    if len(fallbacks) < 2:
        for cand in chat_sorted[1:]:
            if cand["id"] != model_chat and cand["id"] not in fallbacks:
                fallbacks.append(cand["id"])
                if len(fallbacks) == 2:
                    break

    # Always append openrouter/free as the last-resort fallback for chat only
    if "openrouter/free" not in fallbacks:
        fallbacks.append("openrouter/free")

    return {
        "MODEL_GATE": model_gate,
        "GATE_CANDIDATES_TOP3": gate_top3,
        "MODEL_CHAT": model_chat,
        "MODEL_FALLBACKS": ",".join(fallbacks),
    }


def update_env_file(env_path: Path, recs: dict[str, Any]) -> None:
    if not env_path.exists():
        return
    content = env_path.read_text(encoding="utf-8")
    for key in ("MODEL_GATE", "MODEL_CHAT", "MODEL_FALLBACKS"):
        val = recs[key]
        pattern = re.compile(rf"^{key}=.*$", re.MULTILINE)
        if pattern.search(content):
            content = pattern.sub(f"{key}={val}", content)
        else:
            content += f"\n{key}={val}\n"
    env_path.write_text(content, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="List OpenRouter :free tool-calling models and recommend env settings."
    )
    parser.add_argument(
        "--write-env",
        action="store_true",
        help="Write recommended MODEL_GATE, MODEL_CHAT, MODEL_FALLBACKS into ai-service/.env",
    )
    args = parser.parse_args()

    ai_service_dir = Path(__file__).resolve().parent.parent
    load_dotenv(ai_service_dir / ".env")
    api_key = os.getenv("OPENROUTER_API_KEY")

    print("Querying OpenRouter models API (https://openrouter.ai/api/v1/models)...")
    all_models = fetch_openrouter_models(api_key)

    raw_candidates: list[dict[str, Any]] = []
    for m in all_models:
        if is_free_model(m) and supports_tool_calling(m):
            supported_params = set(m.get("supported_parameters") or [])
            model_id = m.get("id", "")
            name = m.get("name", "")
            ctx = int(m.get("context_length") or 0)
            raw_candidates.append(
                {
                    "id": model_id,
                    "name": name,
                    "provider": model_id.split("/")[0],
                    "context_length": ctx,
                    "params_b": estimate_param_billions(model_id, name),
                    "supports_structured": "structured_outputs" in supported_params
                    or "response_format" in supported_params,
                    "uptime": None,
                }
            )

    raw_candidates.sort(key=lambda c: (-c["context_length"], -c["params_b"]))

    # Fetch uptime for up to top 15 candidates to keep script fast
    with httpx.Client(timeout=8.0) as client:
        for cand in raw_candidates[:15]:
            cand["uptime"] = fetch_model_uptime(client, cand["id"])

    print(f"\nFound {len(raw_candidates)} free (:free) models with tool calling:\n")
    print(f"{'MODEL ID':<52} {'CTX':>8} {'EST SIZE':>9} {'JSON/STRUCT':>12} {'UPTIME (30m)':>13}")
    print("-" * 98)
    for c in raw_candidates:
        uptime_str = f"{c['uptime']:.1f}%" if c["uptime"] is not None else "n/a"
        json_str = "yes" if c["supports_structured"] else "no"
        print(
            f"{c['id']:<52} {c['context_length']:>8} {c['params_b']:>8.1f}B {json_str:>12} {uptime_str:>13}"
        )

    if not raw_candidates:
        print("\nNo free tool-calling models returned by OpenRouter.", file=sys.stderr)
        return 1

    recs = pick_recommendations(raw_candidates)
    print("\n=== Recommended Configuration (No hardcoded model IDs in app code) ===")
    print(f"Top 3 Gate Candidates (for evals/run_scope_eval.py): {', '.join(recs['GATE_CANDIDATES_TOP3'])}")
    print(f"MODEL_GATE={recs['MODEL_GATE']}")
    print(f"MODEL_CHAT={recs['MODEL_CHAT']}")
    print(f"MODEL_FALLBACKS={recs['MODEL_FALLBACKS']}")

    if args.write_env:
        env_file = ai_service_dir / ".env"
        update_env_file(env_file, recs)
        print(f"\nUpdated {env_file} with recommended model settings.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

