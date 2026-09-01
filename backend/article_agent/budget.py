from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Sequence

from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
)

from .attachments import (
    attachments_for_message,
    render_current_attachments,
    render_historical_attachments,
)
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

    @staticmethod
    def _clean_message(message: AnyMessage, content: str | None = None) -> BaseMessage:
        value = content if content is not None else ContextBudgeter._content(message)
        if isinstance(message, HumanMessage) or getattr(message, "type", "") == "human":
            return HumanMessage(content=value, id=message.id)
        if isinstance(message, AIMessage) or getattr(message, "type", "") == "ai":
            return AIMessage(content=value, id=message.id)
        return SystemMessage(content=value, id=message.id)

    async def build(
        self,
        *,
        capabilities: ModelCapabilities,
        system_prompt: str,
        latest_instruction: str,
        latest_attachments: Sequence[dict[str, object]] = (),
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

        latest_user_content = latest_instruction + render_current_attachments(
            latest_attachments
        )
        required_parts = [
            system_prompt,
            f"最新指令与参考资料：\n{latest_user_content}",
            f"ArticleBrief：\n{brief.model_dump_json(exclude_none=True)}",
        ]
        if current_content is not None:
            required_parts.append(f"当前正文：\n{current_content}")
        required_tokens = sum(estimator(part) for part in required_parts)
        if required_tokens > available_input:
            raise ContextBudgetExceeded(
                "当前正文、最新指令、完整附件和生成预算已超过模型安全上下文；"
                "请缩短文章或资料、缩小修改范围、拆分发送，或切换更大上下文模型。"
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
                kept_reversed.append(self._clean_message(message))
                remaining -= cost
        kept = list(reversed(kept_reversed))

        # Message bodies have priority. Use only their remaining budget for
        # historical attachments, newest message first, and truncate references
        # rather than instructions when needed.
        for index in range(len(kept) - 1, -1, -1):
            original = kept[index]
            if not isinstance(original, HumanMessage):
                continue
            source = next(
                (item for item in recent if item.id == original.id),
                None,
            )
            if source is None:
                continue
            rendered, used = render_historical_attachments(
                attachments_for_message(source),
                token_budget=remaining,
                estimator=estimator,
            )
            if rendered:
                kept[index] = HumanMessage(
                    content=self._content(original) + rendered,
                    id=original.id,
                )
                remaining -= used
        output: list[BaseMessage] = [SystemMessage(content=system_prompt)]
        output.extend(kept)
        output.append(SystemMessage(content=required_parts[2]))
        if current_content is not None:
            output.append(SystemMessage(content=required_parts[3]))
        output.append(HumanMessage(content=latest_user_content))
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
