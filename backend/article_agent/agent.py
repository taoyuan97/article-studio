from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from .budget import ContextBudgeter
from .cancellation import CancellationToken, RunCancelled
from .graph import GraphNodes, build_graph, message_text, split_article
from .models import ArticleResult, CoreEvent, UserIntent
from .registry import ModelRegistry
from .state import ArticleAgentState


class ArticleAgent:
    """Public graph and provider-neutral streaming facade used by T002."""

    def __init__(
        self,
        registry: ModelRegistry,
        *,
        usage_ratio: float = 0.80,
        recent_message_limit: int = 12,
        callbacks: list[Any] | None = None,
        checkpointer: Any | None = None,
    ) -> None:
        self.nodes = GraphNodes(
            registry,
            ContextBudgeter(usage_ratio, recent_message_limit),
            callbacks,
        )
        self.graph = build_graph(self.nodes, checkpointer)
        self.checkpointer = checkpointer

    async def invoke(
        self, state: ArticleAgentState, *, thread_id: str | None = None
    ) -> ArticleAgentState:
        config = {"configurable": {"thread_id": thread_id}} if thread_id else None
        return await self.graph.ainvoke(state, config=config)

    async def checkpoint(
        self, state: ArticleAgentState, *, thread_id: str
    ) -> None:
        if self.checkpointer is None:
            return
        await self.graph.aupdate_state(
            {"configurable": {"thread_id": thread_id}}, state
        )

    async def checkpoint_values(self, *, thread_id: str) -> dict[str, Any] | None:
        if self.checkpointer is None:
            return None
        snapshot = await self.graph.aget_state(
            {"configurable": {"thread_id": thread_id}}
        )
        return dict(snapshot.values) if snapshot.values else None

    async def stream(
        self,
        state: ArticleAgentState,
        cancellation: CancellationToken | None = None,
    ) -> AsyncIterator[CoreEvent]:
        token = cancellation or CancellationToken()
        run_id = state.get("run_id")
        try:
            token.raise_if_cancelled()
            understood = await self.nodes.understand_input(state)
            working: ArticleAgentState = {**state, **understood}
            intent = working["intent"]

            if intent in {
                UserIntent.CLARIFY,
                UserIntent.RELATED_CHAT,
                UserIntent.UNRELATED_CHAT,
            }:
                handler = {
                    UserIntent.CLARIFY: self.nodes.clarify,
                    UserIntent.RELATED_CHAT: self.nodes.respond,
                    UserIntent.UNRELATED_CHAT: self.nodes.redirect,
                }[intent]
                completed = await handler(working)
                token.raise_if_cancelled()
                yield CoreEvent(
                    type="assistant.delta",
                    run_id=run_id,
                    data={"delta": completed["response"], "intent": intent.value},
                )
                yield CoreEvent(
                    type="run.completed",
                    run_id=run_id,
                    data={
                        "intent": intent.value,
                        "brief": working["brief"].model_dump(),
                        "response": completed["response"],
                    },
                )
                return

            revise = intent is UserIntent.REVISE
            context = await self.nodes._article_context(working, revise)
            chunks: list[str] = []
            usage: dict[str, Any] | None = None
            provider_stream = self.nodes.model(working).astream(
                context.messages, config=self.nodes.invocation_config(working)
            )
            try:
                async for chunk in provider_stream:
                    token.raise_if_cancelled()
                    delta = message_text(chunk)
                    chunk_usage = getattr(chunk, "usage_metadata", None)
                    if chunk_usage:
                        usage = dict(chunk_usage)
                    if not delta:
                        continue
                    chunks.append(delta)
                    yield CoreEvent(
                        type="article.delta", run_id=run_id, data={"delta": delta}
                    )
            finally:
                if token.cancelled and hasattr(provider_stream, "aclose"):
                    await provider_stream.aclose()
            token.raise_if_cancelled()
            title, markdown = split_article("".join(chunks))
            result = ArticleResult(
                title=title,
                content_markdown=markdown,
                kind="revision" if revise else "generation",
            )
            yield CoreEvent(
                type="result.ready",
                run_id=run_id,
                data={
                    "result": result.model_dump(),
                    "conversation_summary": context.conversation_summary,
                    "summary_until_message_id": context.summary_until_message_id,
                    "brief": working["brief"].model_dump(),
                    "usage": usage,
                },
            )
            yield CoreEvent(
                type="run.completed",
                run_id=run_id,
                data={
                    "intent": intent.value,
                    "brief": working["brief"].model_dump(),
                    "usage": usage,
                },
            )
        except RunCancelled:
            # No aggregate or result event is emitted; callers must discard prior deltas.
            yield CoreEvent(type="run.cancelled", run_id=run_id)
        except Exception as exc:
            yield CoreEvent(
                type="run.failed",
                run_id=run_id,
                data={"message": str(exc), "error_type": type(exc).__name__},
            )
