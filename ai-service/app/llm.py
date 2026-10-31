"""OpenRouter client (streaming chat, tool calls, fallback models, friendly rate-limit errors).

Never hardcodes model IDs and never logs message text or document contents.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx
from app.config import settings

logger = logging.getLogger("advoget.llm")


class LLMRateLimitError(Exception):
    """Raised on HTTP 429 or 402 from OpenRouter. Never retried in a loop."""

    def __init__(self, message: str, status_code: int = 429) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class LLMServiceError(Exception):
    """Raised when OpenRouter is unconfigured or all candidate models fail."""

    def __init__(self, message: str, code: str = "LLM_ERROR") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


def _friendly_rate_limit_message(status_code: int) -> str:
    if status_code == 402:
        return (
            "The free AI model quota has been reached (HTTP 402). "
            "On OpenRouter accounts under $10 of lifetime credits, free models allow ~50 requests/day. "
            "Please try again later or add $10 credit once to unlock 1,000 free requests/day."
        )
    return (
        "The AI model rate limit was reached (HTTP 429). "
        "Free OpenRouter models allow up to 20 requests/min and 50 requests/day (or 1,000/day with $10 credit). "
        "Please wait a moment and try again."
    )


def _ensure_api_key() -> str:
    key = settings.openrouter_api_key.strip()
    if not key or "your-key" in key:
        raise LLMServiceError(
            "OPENROUTER_API_KEY is not configured in ai-service/.env.",
            code="CONFIG_ERROR",
        )
    return key


async def stream_chat_completion(
    messages: list[dict[str, Any]],
    models: list[str] | None = None,
    temperature: float = 0.2,
    transport: httpx.AsyncBaseTransport | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Stream tokens from OpenRouter using its native `models` fallback array.

    If a model returns 404/400/5xx before streaming begins, tries the next candidate
    in `models` once. If OpenRouter returns 429 or 402, raises LLMRateLimitError immediately
    without retrying.
    Yields dicts of shape:
      {"type": "token", "text": "..."}
      {"type": "usage", "usage": {"llm_calls": 1, "model": "...", "prompt_tokens": int, "completion_tokens": int}}
    """
    api_key = _ensure_api_key()
    candidate_models = models if models is not None else settings.chat_models_list
    if not candidate_models:
        raise LLMServiceError(
            "No chat models configured. Run scripts/pick_models.py --write-env.",
            code="CONFIG_ERROR",
        )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://advoget.local",
        "X-Title": "Advoget V0 Legal Assistant",
    }

    url = f"{settings.openrouter_base_url.rstrip('/')}/chat/completions"
    last_error_detail = "All configured models failed."

    async with httpx.AsyncClient(timeout=60.0, transport=transport) as client:
        for idx, primary_model in enumerate(candidate_models):
            remaining_fallbacks = candidate_models[idx:]
            payload: dict[str, Any] = {
                "model": primary_model,
                "models": remaining_fallbacks,
                "messages": messages,
                "temperature": temperature,
                "stream": True,
            }

            try:
                async with client.stream("POST", url, headers=headers, json=payload) as resp:
                    if resp.status_code in (429, 402):
                        logger.warning(
                            "OpenRouter rate/quota limit hit: status=%d model=%s",
                            resp.status_code,
                            primary_model,
                        )
                        raise LLMRateLimitError(
                            _friendly_rate_limit_message(resp.status_code),
                            status_code=resp.status_code,
                        )

                    if resp.status_code >= 400:
                        await resp.aread()
                        logger.warning(
                            "Model candidate failed before stream: status=%d model=%s",
                            resp.status_code,
                            primary_model,
                        )
                        last_error_detail = f"Model {primary_model} returned HTTP {resp.status_code}."
                        continue

                    used_model = primary_model
                    prompt_tokens = 0
                    completion_tokens = 0
                    emitted_any = False

                    async for raw_line in resp.aiter_lines():
                        line = raw_line.strip()
                        if not line or line.startswith(":"):
                            continue
                        if not line.startswith("data:"):
                            continue
                        data_str = line[len("data:") :].strip()
                        if data_str == "[DONE]":
                            break

                        try:
                            chunk = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue

                        if "error" in chunk and chunk["error"]:
                            err_obj = chunk["error"]
                            err_code = int(err_obj.get("code") or 500)
                            if err_code in (429, 402):
                                raise LLMRateLimitError(
                                    _friendly_rate_limit_message(err_code),
                                    status_code=err_code,
                                )
                            if not emitted_any:
                                last_error_detail = f"Stream error code {err_code} from {primary_model}"
                                break
                            raise LLMServiceError(
                                "The AI model interrupted the response. Please retry.",
                                code="STREAM_ERROR",
                            )

                        if chunk.get("model"):
                            used_model = str(chunk["model"])

                        usage_obj = chunk.get("usage")
                        if isinstance(usage_obj, dict):
                            prompt_tokens = int(usage_obj.get("prompt_tokens") or prompt_tokens)
                            completion_tokens = int(
                                usage_obj.get("completion_tokens") or completion_tokens
                            )

                        choices = chunk.get("choices") or []
                        if choices:
                            delta = choices[0].get("delta") or {}
                            content_piece = delta.get("content")
                            if content_piece:
                                emitted_any = True
                                yield {"type": "token", "text": str(content_piece)}

                    if emitted_any:
                        yield {
                            "type": "usage",
                            "usage": {
                                "llm_calls": 1,
                                "model": used_model,
                                "prompt_tokens": prompt_tokens,
                                "completion_tokens": completion_tokens,
                            },
                        }
                        return
            except LLMRateLimitError:
                raise
            except httpx.TimeoutException:
                logger.warning("Timeout contacting model=%s", primary_model)
                last_error_detail = f"Timeout contacting {primary_model}."
                continue
            except httpx.HTTPError as exc:
                logger.warning("HTTP error contacting model=%s: %s", primary_model, type(exc).__name__)
                last_error_detail = f"Network error contacting {primary_model}."
                continue

    raise LLMServiceError(
        f"Unable to reach an available AI model ({last_error_detail}). Please try again shortly.",
        code="MODEL_UNAVAILABLE",
    )
