from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ProviderSettings(BaseModel):
    api_key: SecretStr | None = None
    base_url: str
    model: str | None = None
    context_window: int | None = Field(default=None, gt=0)


class Settings(BaseSettings):
    """Environment configuration. Secrets are represented by SecretStr."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    default_llm_provider: Literal["deepseek", "moonshot"] = "deepseek"

    deepseek_api_key: SecretStr | None = None
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str | None = None
    deepseek_context_window: int | None = Field(default=None, gt=0)

    moonshot_api_key: SecretStr | None = None
    moonshot_base_url: str = "https://api.moonshot.cn/v1"
    moonshot_model: str | None = None
    moonshot_context_window: int | None = Field(default=None, gt=0)

    default_image_provider: Literal["aliyun_wanxiang", "dreamina"] | None = None

    aliyun_wanxiang_api_key: SecretStr | None = None
    # Use the workspace domain, e.g. https://<workspace-id>.cn-beijing.maas.aliyuncs.com
    aliyun_wanxiang_base_url: str = ""
    aliyun_wanxiang_model: str = "wanx2.1-t2i-turbo"

    dreamina_api_key: SecretStr | None = None
    # Dreamina/Seedream uses the fixed Ark endpoint; base_url is ignored.
    dreamina_base_url: str = ""
    dreamina_model: str = "doubao-seedream-5-0-lite-260128"

    image_timeout_seconds: float = Field(default=180, gt=0)

    llm_timeout_seconds: float = Field(default=180, gt=0)
    llm_max_retries: int = Field(default=2, ge=0)
    llm_max_output_tokens: int = Field(default=4096, gt=0)
    llm_context_usage_ratio: float = Field(default=0.80, gt=0, le=0.80)
    llm_recent_message_limit: int = Field(default=12, gt=0)

    langsmith_tracing: bool = False
    langsmith_api_key: SecretStr | None = None
    langsmith_project: str = "article-agent-mvp"
    data_dir: Path = Path("data")
    # Production mode: serve frontend/dist static assets with SPA fallback.
    # Keep false during development (Vite dev server owns the frontend).
    serve_frontend: bool = False

    @model_validator(mode="after")
    def validate_enabled_provider(self) -> "Settings":
        provider = self.provider(self.default_llm_provider)
        missing: list[str] = []
        if provider.api_key is None or not provider.api_key.get_secret_value():
            missing.append("API key")
        if not provider.model:
            missing.append("model")
        if not provider.context_window:
            missing.append("context window")
        if missing:
            raise ValueError(
                f"Default provider {self.default_llm_provider!r} is missing: "
                + ", ".join(missing)
            )
        if self.langsmith_tracing and (
            self.langsmith_api_key is None
            or not self.langsmith_api_key.get_secret_value()
        ):
            raise ValueError("LANGSMITH_API_KEY is required when tracing is enabled")
        return self

    def provider(self, name: str) -> ProviderSettings:
        if name == "deepseek":
            return ProviderSettings(
                api_key=self.deepseek_api_key,
                base_url=self.deepseek_base_url,
                model=self.deepseek_model,
                context_window=self.deepseek_context_window,
            )
        if name == "moonshot":
            return ProviderSettings(
                api_key=self.moonshot_api_key,
                base_url=self.moonshot_base_url,
                model=self.moonshot_model,
                context_window=self.moonshot_context_window,
            )
        raise ValueError(f"Unknown provider: {name}")

    def image_provider(self, name: str) -> ProviderSettings:
        if name == "aliyun_wanxiang":
            return ProviderSettings(
                api_key=self.aliyun_wanxiang_api_key,
                base_url=self.aliyun_wanxiang_base_url,
                model=self.aliyun_wanxiang_model,
                context_window=None,
            )
        if name == "dreamina":
            return ProviderSettings(
                api_key=self.dreamina_api_key,
                base_url=self.dreamina_base_url,
                model=self.dreamina_model,
                context_window=None,
            )
        raise ValueError(f"Unknown image provider: {name}")

    def list_image_providers(self) -> list[dict[str, Any]]:
        providers = []
        for name in ("aliyun_wanxiang", "dreamina"):
            config = self.image_provider(name)
            if config.api_key and config.api_key.get_secret_value() and config.base_url and config.model:
                providers.append({
                    "provider": name,
                    "model": config.model,
                    "base_url": config.base_url,
                })
        return providers
