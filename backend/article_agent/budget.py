from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Sequence

from langchain_core.messages import AnyMessage, BaseMessage, HumanMessage, SystemMessage

from .models import ArticleBrief
from .registry import ModelCapabilities


class ContextBudgetExceeded(ValueError):
    pass


Summarizer = Callable[[Sequence[AnyMessage]], Awaitable[str]]


@dataclass(slots=True)
class BudgetedContext:
    messages: list[BaseMessage]
    estimated_input_tokens: int
    limit: int
    conversation_summary: str | None
    summary_until_message_id: str | None


class ContextBudgeter:
    """Build model input while enforcing the configured context invariant."""

    def __init__(self, usage_ratio: float = 0.80, recent_message_limit: int = 12):
        if not 0 < usage_ratio <= 0.80:
            raise ValueError("usage_ratio must be in (0, 0.80]")
        self.usage_ratio = usage_ratio
        self.recent_message_limit = recent_message_limit

    @staticmethod
    def _content(message: AnyMessage) -> str:
        value = message.content
        return value if isinstance(value, str) else str(value)

    @staticmethod
    def _is_relevant_completed(message: AnyMessage) -> bool:
        meta = getattr(message, "additional_kwargs", {})
        return meta.get("status", "completed") == "completed" and meta.get(
            "relevant", True
        )

    async def build(
        self,
        *,
        capabilities: ModelCapabilities,
        system_prompt: str,
        latest_instruction: str,
        brief: ArticleBrief,
        history: Sequence[AnyMessage],
        current_content: str | None = None,
        conversation_summary: str | None = None,
        summary_until_message_id: str | None = None,
        summarizer: Summarizer | None = None,
    ) -> BudgetedContext:
        estimator = capabilities.token_estimator
        limit = int(capabilities.context_window * self.usage_ratio)
        available_input = limit - capabilities.max_output_tokens
        if available_input <= 0:
            raise ContextBudgetExceeded(
                "模型最大输出预算已占满安全上下文，请降低 LLM_MAX_OUTPUT_TOKENS。"
            )

        required_parts = [
            system_prompt,
            f"最新指令：\n{latest_instruction}",
            f"ArticleBrief：\n{brief.model_dump_json(exclude_none=True)}",
        ]
        if current_content is not None:
            required_parts.append(f"当前正文：\n{current_content}")
        required_tokens = sum(estimator(part) for part in required_parts)
        if required_tokens > available_input:
            raise ContextBudgetExceeded(
                "当前正文、最新指令和生成预算已超过模型安全上下文；请缩短文章或缩小修改范围。"
            )

        relevant = [message for message in history if self._is_relevant_completed(message)]
        # The latest instruction is injected explicitly and must not be duplicated.
        if relevant and self._content(relevant[-1]) == latest_instruction:
            relevant = relevant[:-1]
        recent = relevant[-self.recent_message_limit :]
        older = relevant[: -self.recent_message_limit]

        if older and summarizer:
            conversation_summary = await summarizer(older)
            summary_until_message_id = older[-1].id

        optional: list[BaseMessage] = []
        if conversation_summary:
            optional.append(SystemMessage(content=f"较早对话摘要：\n{conversation_summary}"))
        optional.extend(recent)

        remaining = available_input - required_tokens
        kept_reversed: list[BaseMessage] = []
        for message in reversed(optional):
            cost = estimator(self._content(message))
            if cost <= remaining:
                kept_reversed.append(message)
                remaining -= cost
        kept = list(reversed(kept_reversed))
        output: list[BaseMessage] = [SystemMessage(content=system_prompt)]
        output.extend(kept)
        output.append(SystemMessage(content=required_parts[2]))
        if current_content is not None:
            output.append(SystemMessage(content=required_parts[3]))
        output.append(HumanMessage(content=latest_instruction))
        estimated = sum(estimator(self._content(message)) for message in output)
        if estimated + capabilities.max_output_tokens > limit:
            raise AssertionError("context budget invariant violated")
        return BudgetedContext(
            messages=output,
            estimated_input_tokens=estimated,
            limit=limit,
            conversation_summary=conversation_summary,
            summary_until_message_id=summary_until_message_id,
        )
