"""OpenRouter client (streaming chat, gate JSON classification, tool calls, fallback models).

Never hardcodes model IDs and never logs message text or document contents.
"""

from __future__ import annotations

import json
import logging
import re
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


def extract_json_object(raw_text: str) -> dict[str, Any] | None:
    """Extract and parse the first JSON object from an LLM response string."""
    cleaned = raw_text.strip()
    # Strip optional markdown code fences
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{[\s\S]*\}", raw_text)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return None
    return None


async def complete_gate_json(
    messages: list[dict[str, str]],
    model_override: str | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Call the scope gate model at temperature=0 and parse its JSON output.

    Never uses openrouter/free for the gate. Never loops on 429/402.
    """
    api_key = _ensure_api_key()
    if model_override:
        candidate_models = [model_override]
    else:
        candidate_models = [m for m in settings.gate_models_list if m != "openrouter/free"]

    if not candidate_models:
        raise LLMServiceError(
            "No gate model configured. Run scripts/pick_models.py --write-env.",
            code="CONFIG_ERROR",
        )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://advoget.local",
        "X-Title": "Advoget V0 Legal Assistant",
    }
    url = f"{settings.openrouter_base_url.rstrip('/')}/chat/completions"
    last_error = "No gate model returned valid JSON."

    async with httpx.AsyncClient(timeout=25.0, transport=transport) as client:
        for model_id in candidate_models:
            payload: dict[str, Any] = {
                "model": model_id,
                "messages": messages,
                "temperature": 0.0,
                "max_tokens": 250,
            }

            try:
                resp = await client.post(url, headers=headers, json=payload)
                if resp.status_code in (429, 402):
                    logger.warning("Gate rate/quota limit: status=%d model=%s", resp.status_code, model_id)
                    raise LLMRateLimitError(
                        _friendly_rate_limit_message(resp.status_code),
                        status_code=resp.status_code,
                    )

                if resp.status_code >= 400:
                    logger.warning("Gate candidate failed: status=%d model=%s", resp.status_code, model_id)
                    last_error = f"Model {model_id} returned HTTP {resp.status_code}"
                    continue

                body = resp.json()
                if "error" in body and body["error"]:
                    err_code = int(body["error"].get("code") or 500)
                    if err_code in (429, 402):
                        raise LLMRateLimitError(
                            _friendly_rate_limit_message(err_code),
                            status_code=err_code,
                        )
                    last_error = f"Model {model_id} error {err_code}"
                    continue

                choices = body.get("choices") or []
                if not choices:
                    last_error = f"Model {model_id} returned empty choices"
                    continue

                msg = choices[0].get("message") or {}
                content = str(msg.get("content") or "").strip()
                if not content and msg.get("reasoning"):
                    content = str(msg.get("reasoning") or "").strip()

                parsed = extract_json_object(content)
                if parsed and parsed.get("label") in ("legal", "not_legal", "unclear"):
                    parsed["_model"] = body.get("model") or model_id
                    return parsed

                last_error = f"Model {model_id} returned non-conforming JSON"
            except LLMRateLimitError:
                raise
            except httpx.HTTPError as exc:
                logger.warning("HTTP error on gate model=%s: %s", model_id, type(exc).__name__)
                last_error = f"Network error on {model_id}"
                continue

    raise LLMServiceError(f"Scope gate failed ({last_error}).", code="GATE_ERROR")


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
        for primary_model in candidate_models:
            payload: dict[str, Any] = {
                "model": primary_model,
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
