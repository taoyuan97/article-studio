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

    # WeChat Official Account publishing via wenyan-mcp (stdio subprocess).
    wechat_app_id: str = ""
    wechat_app_secret: str = ""
    wenyan_mcp_command: str = "wenyan-mcp"
    # Fake mode: publish without spawning the MCP subprocess or real WeChat calls.
    publish_fake_mode: bool = False

    # Article Studio MCP server (Streamable HTTP at /mcp/), consumed by local agents.
    # Disabled by default: enable explicitly in backend/.env.
    mcp_enabled: bool = False
    # Optional bearer token; when set, every /mcp request must carry it.
    # Blank values are normalised to None so an empty token never enables auth.
    mcp_auth_token: SecretStr | None = None
    # Explicit auth switch. None = infer from token presence (backwards compatible).
    mcp_auth_enabled: bool | None = None
    # Comma-separated hostname allowlist (ports ignored), defense in depth.
    mcp_allowed_hosts: str = "127.0.0.1,localhost,::1"
    # Default wait budget for MCP generation tools before returning a run handle.
    mcp_wait_timeout_seconds: float = Field(default=180, gt=0)

    llm_timeout_seconds: float = Field(default=180, gt=0)
    llm_max_retries: int = Field(default=2, ge=0)
    # 推理模型的思考 token 计入输出预算，多字段结构化输出需预留充足余量
    # （见 docs/issue/ISSUE-003-image-plan-output-truncated.md）
    llm_max_output_tokens: int = Field(default=16384, gt=0)
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

    @model_validator(mode="after")
    def normalize_mcp_settings(self) -> "Settings":
        """Normalise MCP options so blank values never act as real config.

        An empty ``MCP_AUTH_TOKEN`` used to be parsed as ``SecretStr("")`` and
        enabled a guessable "Bearer " check. Blank tokens are now disabled;
        blank host lists fall back to loopback; an explicit auth switch without
        a token is rejected at startup/save time.
        """

        if self.mcp_auth_token is not None:
            token = self.mcp_auth_token.get_secret_value().strip()
            self.mcp_auth_token = SecretStr(token) if token else None
        hosts = [item.strip() for item in self.mcp_allowed_hosts.split(",") if item.strip()]
        self.mcp_allowed_hosts = ",".join(hosts) or "127.0.0.1,localhost,::1"
        if self.mcp_auth_enabled is None:
            self.mcp_auth_enabled = bool(self.mcp_auth_token)
        if self.mcp_auth_enabled and self.mcp_auth_token is None:
            raise ValueError(
                "MCP_AUTH_ENABLED=true 时必须配置非空 MCP_AUTH_TOKEN；"
                "留空会关闭鉴权。"
            )
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
