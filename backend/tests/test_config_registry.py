from __future__ import annotations

from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from article_agent.config import Settings
from article_agent.models import ImagePlanResult
from article_agent.registry import (
    ModelCapabilities,
    ModelRegistry,
    conservative_token_estimate,
)


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


def test_provider_structured_output_methods():
    settings = Settings(
        _env_file=None,
        deepseek_api_key="deepseek-secret",
        deepseek_model="deepseek-model",
        deepseek_context_window=64000,
        moonshot_api_key="moonshot-secret",
        moonshot_model="moonshot-model",
        moonshot_context_window=32000,
    )
    registry = ModelRegistry.from_settings(settings)

    assert (
        registry.get_capabilities(
            "deepseek", "deepseek-model"
        ).structured_output_method
        == "json_mode"
    )
    assert (
        registry.get_capabilities(
            "moonshot", "moonshot-model"
        ).structured_output_method
        == "function_calling"
    )


def test_registry_builds_structured_model_with_provider_method():
    chat_model = Mock()
    structured_model = object()
    chat_model.with_structured_output.return_value = structured_model
    registry = ModelRegistry()
    registry.register(
        "deepseek",
        "model",
        chat_model,
        ModelCapabilities(
            context_window=64000,
            max_output_tokens=4096,
            supports_streaming=True,
            supports_structured_output=True,
            token_estimator=conservative_token_estimate,
            structured_output_method="json_mode",
        ),
    )

    result = registry.get_structured_chat_model(
        "deepseek", "model", ImagePlanResult, include_raw=True
    )

    assert result is structured_model
    chat_model.with_structured_output.assert_called_once_with(
        ImagePlanResult,
        method="json_mode",
        include_raw=True,
    )


def test_registry_rejects_model_without_structured_output():
    registry = ModelRegistry()
    registry.register(
        "fake",
        "plain-model",
        Mock(),
        ModelCapabilities(
            context_window=32000,
            max_output_tokens=2000,
            supports_streaming=True,
            supports_structured_output=False,
            token_estimator=conservative_token_estimate,
        ),
    )

    with pytest.raises(ValueError, match="does not support structured output"):
        registry.get_structured_chat_model("fake", "plain-model", ImagePlanResult)


def test_context_ratio_environment_can_only_lower_limit():
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            deepseek_api_key="secret",
            deepseek_model="model",
            deepseek_context_window=64000,
            llm_context_usage_ratio=0.81,
        )
