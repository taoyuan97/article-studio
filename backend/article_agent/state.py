from __future__ import annotations

from typing import Annotated, Any, TypedDict

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages

from .models import ArticleBrief, ArticleResult, UserIntent


class ArticleAgentState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    conversation_summary: str | None
    summary_until_message_id: str | None
    brief: ArticleBrief
    intent: UserIntent | None
    article_id: str | None
    current_version_id: str | None
    current_title: str | None
    current_content: str | None
    provider: str
    model: str
    force_generate: bool
    status: str
    run_id: str | None
    last_error: str | None
    result: ArticleResult | None
    response: str | None
    route_trace: list[str]


def initial_state(*, provider: str, model: str, **overrides: Any) -> ArticleAgentState:
    state: ArticleAgentState = {
        "messages": [],
        "conversation_summary": None,
        "summary_until_message_id": None,
        "brief": ArticleBrief(),
        "intent": None,
        "article_id": None,
        "current_version_id": None,
        "current_title": None,
        "current_content": None,
        "provider": provider,
        "model": model,
        "force_generate": False,
        "status": "idle",
        "run_id": None,
        "last_error": None,
        "result": None,
        "response": None,
        "route_trace": [],
    }
    state.update(overrides)
    return state
