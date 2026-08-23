from __future__ import annotations

import pytest
from pydantic import ValidationError

from article_agent.config import Settings
from article_agent.registry import ModelRegistry


def test_default_provider_requires_complete_configuration():
    with pytest.raises(ValidationError, match="missing"):
        Settings(_env_file=None)


def test_unused_provider_is_optional():
    settings = Settings(
        _env_file=None,
        deepseek_api_key="secret",
        deepseek_model="configured-by-env",
        deepseek_context_window=64000,
    )
    registry = ModelRegistry.from_settings(settings)
    assert registry.get_capabilities("deepseek", "configured-by-env").context_window == 64000
    with pytest.raises(ValueError, match="not registered"):
        registry.get_chat_model("moonshot", "missing")


def test_context_ratio_environment_can_only_lower_limit():
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            deepseek_api_key="secret",
            deepseek_model="model",
            deepseek_context_window=64000,
            llm_context_usage_ratio=0.81,
        )

