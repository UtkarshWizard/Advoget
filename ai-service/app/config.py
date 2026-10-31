from typing import Literal
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    port: int = 8000
    database_url: str = ""
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    internal_api_key: str = ""

    openrouter_api_key: str = ""
    model_gate: str = ""
    model_chat: str = ""
    model_fallbacks: str = ""

    embeddings_provider: Literal["openrouter", "local"] = "openrouter"
    embed_model: str = ""
    embed_dim: int = 1024

    tavily_api_key: str = ""
    daily_web_search_cap: int = 10

    @property
    def fallback_models_list(self) -> list[str]:
        if not self.model_fallbacks.strip():
            return []
        return [m.strip() for m in self.model_fallbacks.split(",") if m.strip()]


settings = Settings()

