"""Milestone 3 tests for ai-service: model list rules, fallback behavior, and rate-limit handling."""

import asyncio
import json
import httpx

from app.config import Settings
from app.llm import LLMRateLimitError, stream_chat_completion


async def run_tests() -> None:
    print("1. Verifying model configuration rules (openrouter/free in chat only, never gate)...")
    s = Settings(
        openrouter_api_key="sk-or-test-key",
        model_gate="thinkingmachines/inkling-small:free",
        model_chat="nvidia/nemotron-3-ultra-550b-a55b:free",
        model_fallbacks="google/gemma-4-31b-it:free,thinkingmachines/inkling:free",
    )
    assert s.chat_models_list[-1] == "openrouter/free", "openrouter/free must be last fallback for chat"
    assert "openrouter/free" not in s.gate_models_list, "openrouter/free must NEVER be in gate models"
    print("   chat_models_list:", s.chat_models_list)
    print("   gate_models_list:", s.gate_models_list)

    print("2. Verifying fallback from failed primary model to second model...")
    called_models: list[str] = []

    async def fallback_handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        model = body["model"]
        called_models.append(model)
        if model == "primary/down:free":
            return httpx.Response(503, json={"error": {"message": "Provider overloaded"}})

        sse_body = (
            'data: {"model":"fallback/working:free","choices":[{"delta":{"content":"Under Indian law, "}}]}\n\n'
            'data: {"model":"fallback/working:free","choices":[{"delta":{"content":"you can file an application."}}],"usage":{"prompt_tokens":25,"completion_tokens":10}}\n\n'
            "data: [DONE]\n\n"
        )
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            content=sse_body.encode("utf-8"),
        )

    from app import config as config_mod

    orig_key = config_mod.settings.openrouter_api_key
    config_mod.settings.openrouter_api_key = "sk-or-test-key"
    try:
        tokens: list[str] = []
        usage_info = None
        transport = httpx.MockTransport(fallback_handler)
        async for ev in stream_chat_completion(
            messages=[{"role": "user", "content": "My bike was seized"}],
            models=["primary/down:free", "fallback/working:free", "openrouter/free"],
            transport=transport,
        ):
            if ev["type"] == "token":
                tokens.append(ev["text"])
            elif ev["type"] == "usage":
                usage_info = ev["usage"]

        assert called_models == ["primary/down:free", "fallback/working:free"]
        assert "".join(tokens) == "Under Indian law, you can file an application."
        assert usage_info is not None and usage_info["model"] == "fallback/working:free"
        print("   Fallback succeeded:", "".join(tokens))

        print("3. Verifying HTTP 429 from OpenRouter stops immediately (no retry loop)...")
        rate_limit_calls = 0

        async def rate_limit_handler(_request: httpx.Request) -> httpx.Response:
            nonlocal rate_limit_calls
            rate_limit_calls += 1
            return httpx.Response(429, json={"error": {"code": 429, "message": "Rate limit exceeded"}})

        rl_transport = httpx.MockTransport(rate_limit_handler)
        caught_rl = False
        try:
            async for _ in stream_chat_completion(
                messages=[{"role": "user", "content": "Test"}],
                models=["m1:free", "m2:free", "openrouter/free"],
                transport=rl_transport,
            ):
                pass
        except LLMRateLimitError as exc:
            caught_rl = True
            assert "429" in exc.message
            print("   Friendly 429 error:", exc.message)

        assert caught_rl, "Expected LLMRateLimitError on HTTP 429"
        assert rate_limit_calls == 1, f"Expected exactly 1 call (no retry loop), got {rate_limit_calls}"
        print("ALL AI-SERVICE MILESTONE 3 TESTS PASSED!")
    finally:
        config_mod.settings.openrouter_api_key = orig_key


if __name__ == "__main__":
    asyncio.run(run_tests())

