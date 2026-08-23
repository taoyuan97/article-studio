from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from article_agent.image_providers import (
    ImageProvider,
    ImageProviderRegistry,
    resolve_image_size,
)

from .database import NotFoundError, Repository, RunNotActiveError
from .security import redact_sensitive


@dataclass(slots=True)
class BusinessEvent:
    type: str
    data: dict[str, Any]


@dataclass(slots=True)
class ImageRunContext:
    run_id: str
    session_id: str
    token: "ImageCancellationToken" = field(default_factory=lambda: ImageCancellationToken())
    events: list[BusinessEvent] = field(default_factory=list)
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    task: asyncio.Task[None] | None = None
    done: bool = False

    async def publish(self, event_type: str, **data: Any) -> None:
        async with self.condition:
            self.events.append(BusinessEvent(event_type, {"run_id": self.run_id, **data}))
            self.condition.notify_all()

    async def finish(self) -> None:
        async with self.condition:
            self.done = True
            self.condition.notify_all()


class ImageCancellationToken:
    def __init__(self) -> None:
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled


def _build_image_prompt(messages: list[dict[str, Any]], new_instruction: str) -> str:
    parts = []
    for message in messages:
        role_label = "用户" if message["role"] == "user" else "助手"
        content = message["content"] or ""
        if message.get("image_url"):
            content = f"{content}（已生成图片）"
        parts.append(f"{role_label}：{content}")
    parts.append(f"用户新需求：{new_instruction.strip()}")
    return "\n".join(parts)


class ImageRunManager:
    def __init__(
        self,
        repository: Repository,
        registry: ImageProviderRegistry,
        *,
        secret_values: list[str] | None = None,
    ) -> None:
        self.repository = repository
        self.registry = registry
        self.secret_values = secret_values or []
        self._runs: dict[str, ImageRunContext] = {}
        self._active_by_session: dict[str, str] = {}
        self._lock = asyncio.Lock()

    def is_active(self, session_id: str) -> bool:
        return session_id in self._active_by_session

    def active_run_id(self, session_id: str) -> str | None:
        return self._active_by_session.get(session_id)

    async def start(
        self,
        session_id: str,
        *,
        content: str,
        provider: str,
        model: str,
        tier: str | None = None,
        ratio: str | None = None,
    ) -> dict[str, Any]:
        async with self._lock:
            if session_id in self._active_by_session:
                raise RunNotActiveError("IMAGE_RUN_ACTIVE")
            resolved_tier = tier or "2K"
            resolved_ratio = ratio or "1:1"
            size = resolve_image_size(provider, resolved_tier, resolved_ratio)
            run = self.repository.create_image_run(
                session_id,
                content=content,
                provider=provider,
                model=model,
                size=size,
                tier=resolved_tier,
                ratio=resolved_ratio,
            )
            context = ImageRunContext(run["id"], session_id)
            self._runs[run["id"]] = context
            self._active_by_session[session_id] = run["id"]
            context.task = asyncio.create_task(
                self._execute(context), name=f"image-run-{run['id']}"
            )
        return run

    async def _execute(self, context: ImageRunContext) -> None:
        run = self.repository.get_image_run(context.run_id)
        try:
            self.repository.mark_image_run_running(context.run_id)
            await context.publish(
                "run.started",
                session_id=context.session_id,
                user_message_id=run["user_message_id"],
                provider=run["provider"],
                model=run["model"],
            )

            provider = self.registry.get(run["provider"])
            messages = self.repository.list_image_messages(context.session_id)
            prompt = _build_image_prompt(messages[:-1], run["instruction"])

            await context.publish("image.progress", percent=0)
            result = await provider.generate(prompt, size=run.get("size"))
            if context.token.is_cancelled:
                await self._cancel(context)
                return

            await context.publish("image.progress", percent=100)
            message = self.repository.complete_image_run(
                context.run_id,
                image_url=result.storage_url,
                image_prompt=prompt,
                metadata={
                    "width": result.width,
                    "height": result.height,
                    "seed": result.seed,
                },
            )
            await context.publish(
                "image.completed",
                message=message,
                image_url=result.storage_url,
                width=result.width,
                height=result.height,
            )
            await self._clear_active(context)
            await context.publish("run.completed")
        except asyncio.CancelledError:
            await self._cancel(context)
        except RunNotActiveError:
            await self._cancel(context)
        except Exception as exc:
            await self._fail(context, exc)
        finally:
            await context.finish()

    async def _fail(self, context: ImageRunContext, error: object) -> None:
        detail = redact_sensitive(error, self.secret_values)
        readable = "图片生成失败，请稍后重试。"
        message = self.repository.fail_image_run(
            context.run_id,
            message=readable,
            detail=detail,
        )
        if message:
            await context.publish(
                "image.failed",
                message=readable,
                provider_detail=detail,
                retryable=True,
                user_message_id=self.repository.get_image_run(context.run_id)["user_message_id"],
                error_message=message,
            )
            await self._clear_active(context)
            await context.publish("run.completed")

    async def _cancel(self, context: ImageRunContext) -> None:
        changed = self.repository.cancel_image_run(context.run_id)
        if changed and not any(e.type == "run.cancelled" for e in context.events):
            await self._clear_active(context)
            await context.publish("run.cancelled")
            await context.publish("run.completed")

    async def _clear_active(self, context: ImageRunContext) -> None:
        async with self._lock:
            if self._active_by_session.get(context.session_id) == context.run_id:
                self._active_by_session.pop(context.session_id, None)

    async def cancel(self, run_id: str) -> bool:
        context = self._runs.get(run_id)
        if context is None:
            return self.repository.cancel_image_run(run_id)
        changed = self.repository.cancel_image_run(run_id)
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
            run = self.repository.get_image_run(run_id)
            data = {"run_id": run_id}
            if run["status"] == "failed":
                yield BusinessEvent(
                    "image.failed",
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
