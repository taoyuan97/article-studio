from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol

from langchain_deepseek import ChatDeepSeek
from langchain_openai import ChatOpenAI

from .config import Settings


class TokenEstimator(Protocol):
    def __call__(self, text: str) -> int: ...


def conservative_token_estimate(text: str) -> int:
    """Conservative tokenizer-independent estimate for mixed Chinese/English."""

    if not text:
        return 0
    return max(1, (len(text.encode("utf-8")) + 2) // 3) + 8


@dataclass(frozen=True, slots=True)
class ModelCapabilities:
    context_window: int
    max_output_tokens: int
    supports_streaming: bool
    supports_structured_output: bool
    token_estimator: TokenEstimator


class ModelRegistry:
    """The only provider-specific boundary used by business nodes."""

    def __init__(self) -> None:
        self._models: dict[tuple[str, str], Any] = {}
        self._capabilities: dict[tuple[str, str], ModelCapabilities] = {}

    def register(
        self,
        provider: str,
        model: str,
        chat_model: Any,
        capabilities: ModelCapabilities,
    ) -> None:
        key = (provider, model)
        self._models[key] = chat_model
        self._capabilities[key] = capabilities

    def get_chat_model(self, provider: str, model: str) -> Any:
        try:
            return self._models[(provider, model)]
        except KeyError as exc:
            raise ValueError(f"Model is not registered: {provider}/{model}") from exc

    def get_capabilities(self, provider: str, model: str) -> ModelCapabilities:
        try:
            return self._capabilities[(provider, model)]
        except KeyError as exc:
            raise ValueError(f"Model is not registered: {provider}/{model}") from exc

    def list_models(self) -> list[dict[str, Any]]:
        return [
            {
                "provider": provider,
                "model": model,
                "context_window": capabilities.context_window,
            }
            for (provider, model), capabilities in self._capabilities.items()
        ]

    @classmethod
    def from_settings(cls, settings: Settings) -> "ModelRegistry":
        registry = cls()
        for provider in ("deepseek", "moonshot"):
            config = settings.provider(provider)
            if not (
                config.api_key and config.model and config.context_window
            ):
                continue
            common = {
                "model": config.model,
                "api_key": config.api_key.get_secret_value(),
                "base_url": config.base_url,
                "timeout": settings.llm_timeout_seconds,
                "max_retries": settings.llm_max_retries,
                "max_tokens": settings.llm_max_output_tokens,
                "stream_usage": True,
            }
            if provider == "deepseek":
                chat_model = ChatDeepSeek(**common)
            else:
                # Moonshot exposes an OpenAI-compatible Chat Completions API.
                chat_model = ChatOpenAI(**common)
            registry.register(
                provider,
                config.model,
                chat_model,
                ModelCapabilities(
                    context_window=config.context_window,
                    max_output_tokens=settings.llm_max_output_tokens,
                    supports_streaming=True,
                    supports_structured_output=True,
                    token_estimator=conservative_token_estimate,
                ),
            )
        return registry
