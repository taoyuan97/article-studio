from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage

from article_agent.agent import ArticleAgent
from article_agent.budget import ContextBudgetExceeded
from article_agent.cancellation import CancellationToken
from article_agent.models import ArticleBrief, ArticleResult
from article_agent.state import ArticleAgentState, initial_state

from .database import NotFoundError, Repository, RunNotActiveError
from .security import redact_sensitive


@dataclass(slots=True)
class BusinessEvent:
    type: str
    data: dict[str, Any]


@dataclass(slots=True)
class RunContext:
    run_id: str
    article_id: str
    token: CancellationToken = field(default_factory=CancellationToken)
    events: list[BusinessEvent] = field(default_factory=list)
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    task: asyncio.Task[None] | None = None
    done: bool = False

    async def publish(self, event_type: str, **data: Any) -> None:
        async with self.condition:
            self.events.append(
                BusinessEvent(event_type, {"run_id": self.run_id, **data})
            )
            self.condition.notify_all()

    async def finish(self) -> None:
        async with self.condition:
            self.done = True
            self.condition.notify_all()


class RunManager:
    def __init__(
        self,
        repository: Repository,
        agent: ArticleAgent,
        *,
        secret_values: list[str] | None = None,
    ) -> None:
        self.repository = repository
        self.agent = agent
        self.secret_values = secret_values or []
        self._runs: dict[str, RunContext] = {}
        self._active_by_article: dict[str, str] = {}
        self._lock = asyncio.Lock()

    def is_active(self, article_id: str) -> bool:
        return article_id in self._active_by_article

    def active_run_id(self, article_id: str) -> str | None:
        return self._active_by_article.get(article_id)

    async def start(
        self,
        article_id: str,
        *,
        content: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
        retry_message_id: str | None = None,
    ) -> dict[str, Any]:
        async with self._lock:
            if article_id in self._active_by_article:
                raise RunNotActiveError("ARTICLE_RUN_ACTIVE")
            run = self.repository.create_run(
                article_id,
                content=content,
                attachments=attachments,
                retry_message_id=retry_message_id,
            )
            context = RunContext(run["id"], article_id)
            self._runs[run["id"]] = context
            self._active_by_article[article_id] = run["id"]
            context.task = asyncio.create_task(
                self._execute(context), name=f"article-run-{run['id']}"
            )
        return run

    async def _build_state(
        self, run: dict[str, Any], *, include_attachment_content: bool = True
    ) -> ArticleAgentState:
        workspace = self.repository.workspace(
            run["article_id"],
            include_attachment_content=include_attachment_content,
        )
        article = workspace["article"]
        messages = []
        for item in workspace["messages"]:
            metadata = {"status": item["status"]}
            if item["message_type"] in ("redirect", "error"):
                metadata["relevant"] = False
            if item["role"] == "user":
                metadata["article_attachments"] = item.get("attachments", [])
            message_class = HumanMessage if item["role"] == "user" else AIMessage
            messages.append(
                message_class(
                    content=item["content"],
                    id=item["id"],
                    additional_kwargs=metadata,
                )
            )
        latest_human_id = next(
            (
                message.id
                for message in reversed(messages)
                if isinstance(message, HumanMessage)
            ),
            None,
        )
        if latest_human_id != run["user_message_id"]:
            retry_source = self.repository.get_message(
                run["user_message_id"],
                include_attachment_content=include_attachment_content,
            )
            messages.append(
                HumanMessage(
                    content=run["instruction"],
                    id=f"retry-{run['id']}",
                    additional_kwargs={
                        "status": "completed",
                        "article_attachments": retry_source.get("attachments", []),
                    },
                )
            )
        current = workspace["current_version"]
        try:
            checkpoint = await self.agent.checkpoint_values(thread_id=run["thread_id"])
        except Exception:
            checkpoint = None
        state = initial_state(
            provider=run["provider"],
            model=run["model"],
            messages=messages,
            brief=ArticleBrief.model_validate(article["brief"]),
            conversation_summary=article["conversation_summary"],
            summary_until_message_id=article["summary_until_message_id"],
            article_id=article["id"],
            current_version_id=article["current_version_id"],
            current_title=current["title"] if current else None,
            current_content=current["content_markdown"] if current else None,
            run_id=run["id"],
        )
        # Reading the checkpoint proves thread continuity. Per-run controls and all
        # business fields above deliberately come from the business database.
        _ = checkpoint
        return state

    async def _checkpoint_current(self, run: dict[str, Any]) -> None:
        state = await self._build_state(
            self.repository.get_run(run["id"]), include_attachment_content=False
        )
        await self.agent.checkpoint(state, thread_id=run["thread_id"])

    async def _execute(self, context: RunContext) -> None:
        run = self.repository.get_run(context.run_id)
        assistant_text = ""
        intent = "related_chat"
        version_saved = False
        first_token = False
        try:
            self.repository.mark_run_running(context.run_id)
            await context.publish(
                "run.started",
                article_id=context.article_id,
                user_message_id=run["user_message_id"],
                provider=run["provider"],
                model=run["model"],
            )
            state = await self._build_state(run)
            async for event in self.agent.stream(state, context.token):
                if event.type in ("assistant.delta", "article.delta"):
                    if not first_token:
                        self.repository.mark_first_token(context.run_id)
                        first_token = True
                    delta = str(event.data.get("delta", ""))
                    if event.type == "assistant.delta":
                        assistant_text += delta
                        intent = str(event.data.get("intent", intent))
                    await context.publish(event.type, delta=delta)
                elif event.type == "result.ready":
                    result = ArticleResult.model_validate(event.data["result"])
                    brief = ArticleBrief.model_validate(event.data["brief"])
                    version, message = self.repository.persist_version(
                        context.run_id,
                        result=result,
                        brief=brief,
                        summary=event.data.get("conversation_summary"),
                        summary_until=event.data.get("summary_until_message_id"),
                        usage=event.data.get("usage"),
                    )
                    version_saved = True
                    await context.publish("message.completed", message=message)
                    await context.publish(
                        "article.completed", version=version, article=self.repository.get_article(context.article_id)
                    )
                elif event.type == "run.failed":
                    error_type = str(event.data.get("error_type", "MODEL_ERROR"))
                    context_too_large = error_type == "ContextBudgetExceeded"
                    await self._fail(
                        context,
                        event.data.get("message", "模型调用失败"),
                        "ARTICLE_CONTEXT_TOO_LARGE" if context_too_large else error_type,
                        readable=(
                            str(event.data.get("message"))
                            if context_too_large
                            else "模型调用失败，请稍后重试。"
                        ),
                    )
                    return
                elif event.type == "run.cancelled":
                    await self._cancel(context)
                    return
                elif event.type == "run.completed":
                    if not version_saved:
                        intent = str(event.data.get("intent", intent))
                        message_type = {
                            "clarify": "clarification",
                            "unrelated_chat": "redirect",
                            "related_chat": "chat",
                        }.get(intent, "chat")
                        message = self.repository.complete_chat(
                            context.run_id,
                            content=assistant_text or str(event.data.get("response", "")),
                            message_type=message_type,
                            brief=ArticleBrief.model_validate(event.data["brief"]),
                            summary=state.get("conversation_summary"),
                            summary_until=state.get("summary_until_message_id"),
                        )
                        await context.publish("message.completed", message=message)
                    try:
                        await self._checkpoint_current(run)
                    except Exception:
                        # Business persistence is authoritative. A missing or
                        # damaged checkpoint is rebuilt from it on the next run.
                        pass
                    await self._clear_active(context)
                    await context.publish("run.completed")
                    return
        except asyncio.CancelledError:
            await self._cancel(context)
        except RunNotActiveError:
            await self._cancel(context)
        except ContextBudgetExceeded as exc:
            await self._fail(
                context,
                exc,
                "ARTICLE_CONTEXT_TOO_LARGE",
                readable=str(exc),
            )
        except Exception as exc:
            await self._fail(context, exc, type(exc).__name__)
        finally:
            await self._clear_active(context)
            await context.finish()

    async def _fail(
        self,
        context: RunContext,
        error: object,
        error_code: str,
        *,
        readable: str = "模型调用失败，请稍后重试。",
    ) -> None:
        detail = redact_sensitive(error, self.secret_values)
        message = self.repository.fail_run(
            context.run_id,
            message=readable,
            detail=detail,
            error_code=error_code,
        )
        if message:
            run = self.repository.get_run(context.run_id)
            await context.publish(
                "run.failed",
                message=readable,
                provider_detail=detail,
                retryable=True,
                user_message_id=run["user_message_id"],
                error_message=message,
            )
            await self._clear_active(context)
            await context.publish("run.completed")

    async def _cancel(self, context: RunContext) -> None:
        changed = self.repository.cancel_run(context.run_id)
        if changed and not any(e.type == "run.cancelled" for e in context.events):
            await self._clear_active(context)
            await context.publish("run.cancelled")
            await context.publish("run.completed")

    async def _clear_active(self, context: RunContext) -> None:
        async with self._lock:
            if self._active_by_article.get(context.article_id) == context.run_id:
                self._active_by_article.pop(context.article_id, None)

    async def cancel(self, run_id: str) -> bool:
        context = self._runs.get(run_id)
        if context is None:
            return self.repository.cancel_run(run_id)
        changed = self.repository.cancel_run(run_id)
        if not changed:
            return False
        context.token.cancel()
        await self._clear_active(context)
        if not any(event.type == "run.cancelled" for event in context.events):
            await context.publish("run.cancelled")
            await context.publish("run.completed")
        await context.finish()
        if context.task and not context.task.done():
            context.task.cancel()
        return True

    async def events(self, run_id: str):
        context = self._runs.get(run_id)
        if context is None:
            run = self.repository.get_run(run_id)
            data = {"run_id": run_id}
            if run["status"] == "failed":
                yield BusinessEvent(
                    "run.failed",
                    {
                        **data,
                        "message": run["error_message"],
                        "provider_detail": run["raw_provider_error"],
                        "retryable": True,
                        "user_message_id": run["user_message_id"],
                    },
                )
            elif run["status"] == "cancelled":
                yield BusinessEvent("run.cancelled", data)
            yield BusinessEvent("run.completed", data)
            return
        index = 0
        while True:
            async with context.condition:
                await context.condition.wait_for(
                    lambda: index < len(context.events) or context.done
                )
                pending = context.events[index:]
                index = len(context.events)
                done = context.done
            for event in pending:
                yield event
            if done and index >= len(context.events):
                return

    async def shutdown(self) -> None:
        tasks = [context.task for context in self._runs.values() if context.task and not context.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
