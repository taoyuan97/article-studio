from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


class UserIntent(StrEnum):
    CLARIFY = "clarify"
    RELATED_CHAT = "related_chat"
    UNRELATED_CHAT = "unrelated_chat"
    GENERATE = "generate"
    REVISE = "revise"


class ArticleBrief(BaseModel):
    topic: str | None = None
    audience: str | None = None
    purpose: str | None = None
    tone: str | None = None
    platform: str | None = None
    target_length: int | None = Field(default=None, gt=0)
    constraints: list[str] = Field(default_factory=list)


class IntentDecision(BaseModel):
    intent: UserIntent
    brief: ArticleBrief
    force_generate: bool = False


class ArticleResult(BaseModel):
    title: str
    content_markdown: str
    kind: Literal["generation", "revision"]


class CoreEvent(BaseModel):
    type: Literal[
        "assistant.delta",
        "article.delta",
        "result.ready",
        "run.cancelled",
        "run.failed",
        "run.completed",
    ]
    run_id: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)

