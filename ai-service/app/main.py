from fastapi import Depends, FastAPI, Header, HTTPException, status
from app.config import settings

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
async def chat_stream_stub() -> dict[str, str]:
    """Milestone 3+: Streaming chat with scope guard and tools."""
    return {"status": "stub", "detail": "Implemented in Milestone 3"}

