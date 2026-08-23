from __future__ import annotations

import pytest

from article_agent.agent import ArticleAgent
from article_agent.models import ArticleBrief
from article_agent.registry import ModelCapabilities, ModelRegistry, conservative_token_estimate

from .fakes import FakeChatModel


@pytest.fixture
def make_agent():
    def factory(decisions, responses=None, *, context_window=32000, max_output=2000):
        fake = FakeChatModel(decisions=decisions, responses=responses)
        registry = ModelRegistry()
        registry.register(
            "fake",
            "fake-model",
            fake,
            ModelCapabilities(
                context_window=context_window,
                max_output_tokens=max_output,
                supports_streaming=True,
                supports_structured_output=True,
                token_estimator=conservative_token_estimate,
            ),
        )
        return ArticleAgent(registry), fake

    return factory
