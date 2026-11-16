import json
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.llm import LLMRateLimitError, LLMServiceError, stream_chat_completion
from app.prompts import build_system_prompt
from app.scope import evaluate_scope

app = FastAPI(
    title="Advoget AI Service",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
)


def verify_internal_key(
    x_internal_key: str | None = Header(default=None, alias="X-Internal-Key"),
) -> None:
    if not settings.internal_api_key or x_internal_key != settings.internal_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Key header",
        )


class ChatHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatStreamRequest(BaseModel):
    user_id: str
    audience: Literal["citizen", "lawyer"] = "citizen"
    messages: list[ChatHistoryMessage] = Field(default_factory=list, max_length=10)
    document_ids: list[str] = Field(default_factory=list)
    doc_previews: list[str] = Field(default_factory=list)
    remaining_budget: int = 4


def format_sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "ai-service",
    }


@app.post("/ai/documents/ingest", dependencies=[Depends(verify_internal_key)])
async def ingest_document_stub() -> dict[str, str]:
    """Milestone 7: Document ingestion pipeline."""
    return {"status": "stub", "detail": "Implemented in Milestone 7"}


@app.post("/ai/chat/stream", dependencies=[Depends(verify_internal_key)])
async def chat_stream(req: ChatStreamRequest) -> StreamingResponse:
    """Milestone 4: Scope guard (heuristics + LLM gate) before streaming chat."""

    async def event_generator() -> AsyncIterator[str]:
        if req.remaining_budget <= 0:
            yield format_sse(
                "error",
                {
                    "code": "DAILY_LIMIT_REACHED",
                    "message": "You have reached your daily message limit. Please try again tomorrow.",
                },
            )
            return

        if not req.messages:
            yield format_sse(
                "error",
                {
                    "code": "INVALID_INPUT",
                    "message": "No message provided.",
                },
            )
            return

        latest_message = req.messages[-1].content
        prior_history = [
            {"role": m.role, "content": m.content}
            for m in req.messages[:-1]
        ]

        try:
            # Step 1: Scope Guard (heuristics + LLM gate)
            yield format_sse("status", {"stage": "checking_scope"})

            scope_res = await evaluate_scope(
                user_message=latest_message,
                history=prior_history,
                has_doc=bool(req.document_ids),
                doc_previews=req.doc_previews,
            )

            if scope_res.label == "not_legal":
                yield format_sse(
                    "refusal",
                    {
                        "message": scope_res.response_message or "",
                        "scope_label": "not_legal",
                    },
                )
                yield format_sse(
                    "done",
                    {
                        "scope_label": "not_legal",
                        "usage": {"llm_calls": scope_res.llm_calls},
                    },
                )
                return

            if scope_res.label == "greeting":
                yield format_sse("token", {"text": scope_res.response_message or ""})
                yield format_sse("sources", {"items": []})
                yield format_sse(
                    "done",
                    {
                        "scope_label": "legal",
                        "usage": {"llm_calls": 0},
                    },
                )
                return

            if scope_res.label == "unclear":
                yield format_sse("token", {"text": scope_res.response_message or ""})
                yield format_sse("sources", {"items": []})
                yield format_sse(
                    "done",
                    {
                        "scope_label": "unclear",
                        "usage": {"llm_calls": scope_res.llm_calls},
                    },
                )
                return

            # Step 2: Legal in-scope -> Main Chat Model
            yield format_sse("status", {"stage": "answering"})

            llm_messages: list[dict[str, Any]] = [
                {"role": "system", "content": build_system_prompt(req.audience)},
                *[
                    {"role": m.role, "content": m.content}
                    for m in req.messages[-10:]
                ],
            ]

            usage_summary: dict[str, Any] = {"llm_calls": scope_res.llm_calls + 1}

            async for item in stream_chat_completion(messages=llm_messages):
                if item["type"] == "token":
                    yield format_sse("token", {"text": item["text"]})
                elif item["type"] == "usage":
                    chat_usage = item["usage"]
                    usage_summary = {
                        **chat_usage,
                        "llm_calls": scope_res.llm_calls + int(chat_usage.get("llm_calls", 1)),
                    }

            yield format_sse("sources", {"items": []})
            yield format_sse(
                "done",
                {
                    "scope_label": "legal",
                    "usage": usage_summary,
                },
            )
        except LLMRateLimitError as exc:
            yield format_sse(
                "error",
                {
                    "code": "RATE_LIMIT",
                    "message": exc.message,
                },
            )
        except LLMServiceError as exc:
            yield format_sse(
                "error",
                {
                    "code": exc.code,
                    "message": exc.message,
                },
            )
        except Exception:
            yield format_sse(
                "error",
                {
                    "code": "INTERNAL_ERROR",
                    "message": "An unexpected error occurred in the AI service.",
                },
            )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
