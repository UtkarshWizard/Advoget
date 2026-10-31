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
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    model_gate: str = ""
    model_chat: str = ""
    model_fallbacks: str = ""

    embeddings_provider: Literal["openrouter", "local"] = "openrouter"
    embed_model: str = "nvidia/nemotron-3.5-embed-1b:free"
    embed_dim: int = 1024

    tavily_api_key: str = ""
    daily_web_search_cap: int = 10

    @property
    def fallback_models_list(self) -> list[str]:
        if not self.model_fallbacks.strip():
            return []
        return [m.strip() for m in self.model_fallbacks.split(",") if m.strip()]

    @property
    def chat_models_list(self) -> list[str]:
        """Ordered list of chat models: primary MODEL_CHAT, configured fallbacks,
        and openrouter/free as the last-resort fallback for chat only."""
        models: list[str] = []
        if self.model_chat.strip():
            models.append(self.model_chat.strip())
        for fb in self.fallback_models_list:
            if fb not in models:
                models.append(fb)
        if "openrouter/free" not in models:
            models.append("openrouter/free")
        return models

    @property
    def gate_models_list(self) -> list[str]:
        """Models for the scope gate: never includes openrouter/free."""
        models: list[str] = []
        if self.model_gate.strip() and self.model_gate.strip() != "openrouter/free":
            models.append(self.model_gate.strip())
        for fb in self.fallback_models_list:
            if fb != "openrouter/free" and fb not in models:
                models.append(fb)
        return models


settings = Settings()
