import json
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.llm import LLMRateLimitError, LLMServiceError, stream_chat_completion
from app.prompts import build_system_prompt

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
    """Milestone 3: Streaming chat end-to-end with model fallbacks and friendly rate-limit errors."""

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

        yield format_sse("status", {"stage": "answering"})

        llm_messages: list[dict[str, Any]] = [
            {"role": "system", "content": build_system_prompt(req.audience)},
            *[
                {"role": m.role, "content": m.content}
                for m in req.messages[-10:]
            ],
        ]

        usage_summary: dict[str, Any] = {"llm_calls": 1}

        try:
            async for item in stream_chat_completion(messages=llm_messages):
                if item["type"] == "token":
                    yield format_sse("token", {"text": item["text"]})
                elif item["type"] == "usage":
                    usage_summary = item["usage"]

            yield format_sse("sources", {"items": []})
            yield format_sse("done", {"usage": usage_summary})
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
