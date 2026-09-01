from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph

from .budget import BudgetedContext, ContextBudgeter
from .attachments import (
    attachment_descriptors,
    attachments_for_message,
    render_current_attachments,
)
from .models import ArticleResult, IntentDecision, UserIntent
from .prompts import (
    INTENT_SYSTEM_PROMPT,
    RELATED_SYSTEM_PROMPT,
    REVISION_SYSTEM_PROMPT,
    WRITING_SYSTEM_PROMPT,
)
from .registry import ModelRegistry
from .state import ArticleAgentState


def message_text(message: Any) -> str:
    content = getattr(message, "content", message)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            item.get("text", "") if isinstance(item, dict) else str(item)
            for item in content
        )
    return str(content)


def latest_user_text(state: ArticleAgentState) -> str:
    for message in reversed(state.get("messages", [])):
        if isinstance(message, HumanMessage) or getattr(message, "type", "") == "human":
            return message_text(message)
    raise ValueError("No user message is available")


def latest_user_message(state: ArticleAgentState) -> AnyMessage:
    for message in reversed(state.get("messages", [])):
        if isinstance(message, HumanMessage) or getattr(message, "type", "") == "human":
            return message
    raise ValueError("No user message is available")


def split_article(markdown: str) -> tuple[str, str]:
    clean = markdown.strip()
    if clean.startswith("```") and clean.endswith("```"):
        lines = clean.splitlines()
        clean = "\n".join(lines[1:-1]).strip()
    lines = clean.splitlines()
    if not lines:
        raise ValueError("模型没有返回文章内容")
    if lines[0].startswith("# "):
        title = lines[0][2:].strip()
        body = "\n".join(lines[1:]).strip()
    else:
        title = lines[0].lstrip("# ").strip()
        body = "\n".join(lines[1:]).strip()
        clean = f"# {title}\n\n{body}".strip()
    if not title or not body:
        raise ValueError("模型返回的标题或正文为空")
    return title, clean


class GraphNodes:
    def __init__(
        self,
        registry: ModelRegistry,
        budgeter: ContextBudgeter,
        callbacks: list[Any] | None = None,
    ) -> None:
        self.registry = registry
        self.budgeter = budgeter
        self.callbacks = callbacks or []

    def model(self, state: ArticleAgentState) -> Any:
        return self.registry.get_chat_model(state["provider"], state["model"])

    @property
    def config(self) -> dict[str, Any]:
        return {"callbacks": self.callbacks} if self.callbacks else {}

    def invocation_config(self, state: ArticleAgentState) -> dict[str, Any]:
        # Full reference text must not be copied into tracing callbacks. Runs
        # without attachments retain the existing observability behavior.
        if any(attachments_for_message(message) for message in state.get("messages", [])):
            return {}
        return self.config

    async def understand_input(self, state: ArticleAgentState) -> dict[str, Any]:
        # JSON mode is the stable intersection of DeepSeek and Moonshot's
        # OpenAI-compatible endpoints; Pydantic remains the validation boundary.
        model = self.model(state).with_structured_output(
            IntentDecision, method="json_mode"
        )
        latest = latest_user_text(state)
        latest_attachments = attachments_for_message(latest_user_message(state))
        prompt = [
            SystemMessage(content=INTENT_SYSTEM_PROMPT),
            SystemMessage(
                content=(
                    f"已有 Brief：{state['brief'].model_dump_json(exclude_none=True)}\n"
                    f"已有正文：{'是' if state.get('current_content') else '否'}\n"
                    f"附件描述：{attachment_descriptors(latest_attachments)}\n"
                    "附件正文未提供给本阶段；当用户明确要求根据附件处理时，"
                    "不要仅因 Brief 缺少附件中可能包含的信息而追问。"
                )
            ),
            HumanMessage(content=latest),
        ]
        error: Exception | None = None
        for attempt in range(2):
            try:
                decision = await model.ainvoke(prompt, config=self.config)
                if not isinstance(decision, IntentDecision):
                    decision = IntentDecision.model_validate(decision)
                if state.get("force_generate") or decision.force_generate:
                    decision.intent = UserIntent.REVISE if state.get("current_content") else UserIntent.GENERATE
                    decision.force_generate = True
                brief = state["brief"] if decision.intent is UserIntent.UNRELATED_CHAT else decision.brief
                return {
                    "intent": decision.intent,
                    "brief": brief,
                    "force_generate": decision.force_generate,
                    "status": "understood",
                    "route_trace": [*state.get("route_trace", []), "understand_input"],
                }
            except Exception as exc:  # one corrective retry is intentional
                error = exc
                prompt.append(
                    HumanMessage(content="上次输出未通过结构校验。请仅按指定 schema 重新输出。")
                )
        raise ValueError("无法识别写作意图，请换一种方式描述。") from error

    async def clarify(self, state: ArticleAgentState) -> dict[str, Any]:
        brief = state["brief"]
        questions = [
            (brief.topic, "你最想写的核心主题是什么？"),
            (brief.purpose, "这篇文章最希望读者读完后获得什么？"),
            (brief.audience, "这篇文章主要写给谁看？"),
        ]
        response = next((question for value, question in questions if not value), "你希望我重点补充哪一部分？")
        return {
            "response": response,
            "messages": [AIMessage(content=response)],
            "status": "awaiting_user",
            "route_trace": [*state.get("route_trace", []), "clarify"],
        }

    async def respond(self, state: ArticleAgentState) -> dict[str, Any]:
        latest = latest_user_message(state)
        context = await self.budgeter.build(
            capabilities=self.registry.get_capabilities(
                state["provider"], state["model"]
            ),
            system_prompt=RELATED_SYSTEM_PROMPT,
            latest_instruction=message_text(latest),
            latest_attachments=attachments_for_message(latest),
            brief=state["brief"],
            history=state.get("messages", []),
            conversation_summary=state.get("conversation_summary"),
            summary_until_message_id=state.get("summary_until_message_id"),
            summarizer=lambda messages: self._summarize_history(state, list(messages)),
        )
        response = message_text(
            await self.model(state).ainvoke(
                context.messages, config=self.invocation_config(state)
            )
        )
        return {
            "response": response,
            "messages": [AIMessage(content=response)],
            "status": "completed",
            "route_trace": [*state.get("route_trace", []), "respond"],
        }

    async def redirect(self, state: ArticleAgentState) -> dict[str, Any]:
        response = "这个问题与当前文章无关；我们继续完善这篇文章吧。"
        return {
            "response": response,
            "messages": [AIMessage(content=response, additional_kwargs={"relevant": False})],
            "status": "completed",
            "route_trace": [*state.get("route_trace", []), "redirect"],
        }

    async def _summarize_history(
        self, state: ArticleAgentState, messages: list[AnyMessage]
    ) -> str:
        """Summarize in bounded batches so summary calls obey the same 80% ceiling."""

        capabilities = self.registry.get_capabilities(state["provider"], state["model"])
        estimator = capabilities.token_estimator
        max_input = int(capabilities.context_window * self.budgeter.usage_ratio)
        max_input -= capabilities.max_output_tokens
        prompt_cost = estimator("压缩较早对话，保留写作决定、约束和未决事项。")
        available = max(1, max_input - prompt_cost)
        summary = state.get("conversation_summary") or ""
        batches: list[list[AnyMessage]] = []
        batch: list[AnyMessage] = []
        batch_cost = estimator(summary)
        for message in messages:
            text = message_text(message) + render_current_attachments(
                attachments_for_message(message)
            )
            cost = estimator(text)
            if batch and batch_cost + cost > available:
                batches.append(batch)
                batch = []
                batch_cost = estimator(summary)
            # An individual pathological message is conservatively tail-truncated.
            if cost > available:
                message = HumanMessage(content=text[: available * 2], id=message.id)
                cost = estimator(message_text(message))
            batch.append(message)
            batch_cost += cost
        if batch:
            batches.append(batch)
        for items in batches:
            transcript = "\n".join(
                f"{getattr(item, 'type', 'message')}: "
                f"{message_text(item)}{render_current_attachments(attachments_for_message(item))}"
                for item in items
            )
            response = await self.model(state).ainvoke(
                [
                    SystemMessage(content="压缩较早对话，保留写作决定、约束和未决事项。"),
                    HumanMessage(content=f"已有摘要：{summary}\n\n新增对话：\n{transcript}"),
                ],
                config=self.invocation_config(state),
            )
            summary = message_text(response).strip()
        return summary

    async def _article_context(self, state: ArticleAgentState, revise: bool) -> BudgetedContext:
        capabilities = self.registry.get_capabilities(state["provider"], state["model"])
        latest = latest_user_message(state)
        return await self.budgeter.build(
            capabilities=capabilities,
            system_prompt=REVISION_SYSTEM_PROMPT if revise else WRITING_SYSTEM_PROMPT,
            latest_instruction=message_text(latest),
            latest_attachments=attachments_for_message(latest),
            brief=state["brief"],
            history=state.get("messages", []),
            current_content=state.get("current_content") if revise else None,
            conversation_summary=state.get("conversation_summary"),
            summary_until_message_id=state.get("summary_until_message_id"),
            summarizer=lambda messages: self._summarize_history(state, list(messages)),
        )

    async def _write(self, state: ArticleAgentState, revise: bool) -> dict[str, Any]:
        context = await self._article_context(state, revise)
        response = message_text(
            await self.model(state).ainvoke(
                context.messages, config=self.invocation_config(state)
            )
        )
        title, markdown = split_article(response)
        result = ArticleResult(
            title=title,
            content_markdown=markdown,
            kind="revision" if revise else "generation",
        )
        return {
            "result": result,
            "conversation_summary": context.conversation_summary,
            "summary_until_message_id": context.summary_until_message_id,
            "status": "result_ready",
            "route_trace": [
                *state.get("route_trace", []),
                "revise_article" if revise else "generate_article",
            ],
        }

    async def generate_article(self, state: ArticleAgentState) -> dict[str, Any]:
        return await self._write(state, False)

    async def revise_article(self, state: ArticleAgentState) -> dict[str, Any]:
        return await self._write(state, True)

    async def result_ready(self, state: ArticleAgentState) -> dict[str, Any]:
        return {
            "status": "completed",
            "route_trace": [*state.get("route_trace", []), "result_ready"],
        }


def route_intent(state: ArticleAgentState) -> str:
    intent = state.get("intent")
    if intent is None:
        raise ValueError("Intent was not set")
    return intent.value


def build_graph(nodes: GraphNodes, checkpointer: Any | None = None):
    builder = StateGraph(ArticleAgentState)
    builder.add_node("understand_input", nodes.understand_input)
    builder.add_node("clarify", nodes.clarify)
    builder.add_node("respond", nodes.respond)
    builder.add_node("redirect", nodes.redirect)
    builder.add_node("generate_article", nodes.generate_article)
    builder.add_node("revise_article", nodes.revise_article)
    builder.add_node("result_ready", nodes.result_ready)
    builder.add_edge(START, "understand_input")
    builder.add_conditional_edges(
        "understand_input",
        route_intent,
        {
            "clarify": "clarify",
            "related_chat": "respond",
            "unrelated_chat": "redirect",
            "generate": "generate_article",
            "revise": "revise_article",
        },
    )
    builder.add_edge("clarify", END)
    builder.add_edge("respond", END)
    builder.add_edge("redirect", END)
    builder.add_edge("generate_article", "result_ready")
    builder.add_edge("revise_article", "result_ready")
    builder.add_edge("result_ready", END)
    return builder.compile(checkpointer=checkpointer)
