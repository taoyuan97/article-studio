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


class ImagePlanImage(BaseModel):
    """单张配图：block_index 与发布 after_block_{n} 锚点共用同一编号
    （服务层统一 clamp 到 [1, 块总数]，LLM 原始输出可为任意整数）。"""

    block_index: int
    position_hint: str
    layout: Literal["landscape", "square", "portrait"]
    layout_reason: str
    prompt: str


class ImagePlanResult(BaseModel):
    """文章配图编排方案（LLM 结构化输出）。images 可为空（由服务层判 PLAN_EMPTY）。"""

    mood: str
    style_summary: str
    images: list[ImagePlanImage] = Field(default_factory=list)


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

