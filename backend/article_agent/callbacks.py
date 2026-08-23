from __future__ import annotations

from typing import Any

from .config import Settings


def build_callbacks(settings: Settings) -> list[Any]:
    """Build optional tracing callbacks without relying on global environment state."""

    if not settings.langsmith_tracing:
        return []
    from langchain_core.tracers.langchain import LangChainTracer
    from langsmith import Client

    return [
        LangChainTracer(
            project_name=settings.langsmith_project,
            client=Client(
                api_key=settings.langsmith_api_key.get_secret_value()
                if settings.langsmith_api_key
                else None
            ),
        )
    ]
