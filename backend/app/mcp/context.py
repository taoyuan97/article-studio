"""Shared MCP context and helpers.

Tools are thin adapters over the services already living on ``app.state``; this
module centralises state access, record shaping, run waiting and error mapping so
the tool modules stay declarative.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import logging
from typing import Any

from fastapi import FastAPI
from mcp.server.fastmcp.exceptions import ToolError

from ..database import NotFoundError, RunNotActiveError
from ..security import redact_sensitive

logger = logging.getLogger(__name__)

ARTICLE_TERMINAL_EVENTS = {"run.failed", "run.cancelled", "run.completed"}
IMAGE_TERMINAL_EVENTS = {"image.failed", "run.cancelled", "run.completed"}

_MAX_WAIT_SECONDS = 600.0


def tool_error(code: str, message: str) -> ToolError:
    """Build a structured MCP tool error rendered as ``CODE: message``."""

    return ToolError(f"{code}: {message}")


def guarded(ctx: "McpContext"):
    """Map domain exceptions to structured tool errors for every MCP tool.

    FastMCP wraps unexpected exceptions as ``Error executing tool ...``; mapping
    here keeps codes stable for agents and prevents raw provider errors (which
    may embed request details) from reaching the client unredacted.
    """

    def decorator(fn: Any) -> Any:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            try:
                result = fn(*args, **kwargs)
                if inspect.isawaitable(result):
                    result = await result
                return result
            except ToolError:
                raise
            except NotFoundError as exc:
                raise tool_error("NOT_FOUND", str(exc)) from exc
            except RunNotActiveError as exc:
                text = str(exc)
                code = (
                    text
                    if text
                    in {"ARTICLE_RUN_ACTIVE", "IMAGE_RUN_ACTIVE", "SETTINGS_RUN_ACTIVE"}
                    else "RUN_NOT_ACTIVE"
                )
                raise tool_error(code, text) from exc
            except Exception as exc:  # pragma: no cover - defensive boundary
                logger.exception("MCP tool %s failed", getattr(fn, "__name__", "?"))
                raise tool_error("MCP_TOOL_ERROR", ctx.redact(exc)) from exc

        return wrapper

    return decorator


def mask_secret(value: str) -> str | None:
    if not value:
        return None
    if len(value) <= 4:
        return f"{value[:1]}***"
    return f"{value[:3]}***{value[-4:]}"


def resolve_wait_timeout(ctx: "McpContext", timeout_seconds: float | None) -> float:
    value = timeout_seconds if timeout_seconds is not None else ctx.settings.mcp_wait_timeout_seconds
    value = float(value)
    if value <= 0:
        raise tool_error("INVALID_ARGUMENT", "timeout_seconds 必须大于 0")
    return min(value, _MAX_WAIT_SECONDS)


def resolve_llm_selection(
    ctx: "McpContext", provider: str | None, model: str | None
) -> tuple[str, str]:
    resolved_provider = provider or ctx.settings.default_llm_provider
    try:
        provider_config = ctx.settings.provider(resolved_provider)
    except ValueError as exc:
        raise tool_error("INVALID_ARGUMENT", str(exc)) from exc
    resolved_model = model or provider_config.model
    if not resolved_model:
        raise tool_error(
            "MODEL_NOT_CONFIGURED",
            f"{resolved_provider} 未配置模型 ID，请到设置页完成配置。",
        )
    try:
        ctx.registry.get_capabilities(resolved_provider, resolved_model)
    except ValueError as exc:
        raise tool_error("MODEL_NOT_CONFIGURED", str(exc)) from exc
    return resolved_provider, resolved_model


def resolve_image_selection(
    ctx: "McpContext", provider: str | None, model: str | None
) -> tuple[str, str]:
    providers = ctx.image_registry.list()
    if not providers:
        raise tool_error(
            "IMAGE_PROVIDER_NOT_CONFIGURED",
            "未配置可用的生图模型，请到设置页完成配置。",
        )
    by_name = {item["provider"]: item["model"] for item in providers}
    if provider is not None:
        if provider not in by_name:
            raise tool_error(
                "IMAGE_PROVIDER_NOT_CONFIGURED",
                f"生图 provider 不可用：{provider}；"
                f"当前可用：{', '.join(by_name)}",
            )
        resolved_provider = provider
    else:
        resolved_provider = ctx.settings.default_image_provider
        if resolved_provider not in by_name:
            resolved_provider = providers[0]["provider"]
    configured_model = by_name[resolved_provider]
    if model and model != configured_model:
        raise tool_error(
            "INVALID_ARGUMENT",
            f"生图模型由设置页决定（{resolved_provider}/{configured_model}），"
            "调用时不能改用它模型。",
        )
    return resolved_provider, configured_model


class McpContext:
    """Late-bound accessor for services created in the FastAPI lifespan."""

    def __init__(self, application: FastAPI) -> None:
        self.application = application

    @property
    def state(self) -> Any:
        return self.application.state

    @property
    def settings(self) -> Any:
        return self.state.settings

    @property
    def repository(self) -> Any:
        return self.state.repository

    @property
    def manager(self) -> Any:
        return self.state.manager

    @property
    def image_manager(self) -> Any:
        return self.state.image_manager

    @property
    def registry(self) -> Any:
        return self.state.registry

    @property
    def image_registry(self) -> Any:
        return self.state.image_registry

    @property
    def wenyan_client(self) -> Any:
        return self.state.wenyan_client

    @property
    def data_dir(self) -> Any:
        return self.state.data_dir

    @property
    def secret_values(self) -> list[str]:
        return list(self.state.secret_values)

    def redact(self, value: object) -> str:
        return redact_sensitive(value, self.secret_values)


# ---------------------------------------------------------------------------
# Record shaping
# ---------------------------------------------------------------------------


def article_payload(article: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": article["id"],
        "title": article["title"],
        "status": article["status"],
        "provider": article["provider"],
        "model": article["model"],
        "version_count": article.get("version_count"),
        "current_version_id": article.get("current_version_id"),
        "created_at": article["created_at"],
        "updated_at": article["updated_at"],
    }


def version_payload(
    version: dict[str, Any], *, include_content: bool = True
) -> dict[str, Any]:
    payload = {
        "id": version["id"],
        "article_id": version["article_id"],
        "version_number": version["version_number"],
        "title": version["title"],
        "provider": version["provider"],
        "model": version["model"],
        "created_at": version["created_at"],
    }
    if include_content:
        payload["content_markdown"] = version["content_markdown"]
    return payload


def asset_payload(asset: dict[str, Any]) -> dict[str, Any]:
    metadata = asset.get("metadata") or {}
    return {
        "id": asset["id"],
        "title": asset["title"],
        "storage_url": asset["storage_url"],
        "width": metadata.get("width"),
        "height": metadata.get("height"),
        "provider": asset.get("provider"),
        "model": asset.get("model"),
        "created_at": asset["created_at"],
    }


def publish_record_payload(
    record: dict[str, Any], *, include_snapshot: bool = False
) -> dict[str, Any]:
    payload = {
        "id": record["id"],
        "article_id": record["article_id"],
        "article_title": record.get("article_title"),
        "version_id": record.get("version_id"),
        "theme_id": record["theme_id"],
        "cover_asset_id": record.get("cover_asset_id"),
        "author": record.get("author"),
        "status": record["status"],
        "media_id": record.get("media_id"),
        "error_code": record.get("error_code"),
        "error_message": record.get("error_message"),
        "created_at": record["created_at"],
    }
    if include_snapshot:
        payload["content_snapshot"] = record.get("content_snapshot")
    return payload


def wechat_payload(ctx: "McpContext") -> dict[str, Any]:
    settings = ctx.settings
    return {
        "configured": bool(settings.wechat_app_id and settings.wechat_app_secret),
        "app_id_masked": mask_secret(settings.wechat_app_id),
        "publish_fake_mode": settings.publish_fake_mode,
        "draft_only": True,
    }


# ---------------------------------------------------------------------------
# Run waiting
# ---------------------------------------------------------------------------


async def collect_run_events(
    manager: Any,
    run_id: str,
    timeout: float,
    terminal_events: set[str],
) -> tuple[list[Any], bool]:
    """Collect events until a terminal one; return (events, timed_out)."""

    events: list[Any] = []
    try:
        async with asyncio.timeout(timeout):
            async for event in manager.events(run_id):
                events.append(event)
                if event.type in terminal_events:
                    break
    except TimeoutError:
        return events, True
    return events, False


def find_event(events: list[Any], event_type: str) -> Any | None:
    for event in reversed(events):
        if event.type == event_type:
            return event
    return None


def running_payload(run_id: str, kind: str, events: list[Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": "running",
        "run_id": run_id,
        "kind": kind,
        "hint": "运行仍在后台继续。可再次调用 wait_for_run(run_id=..., kind=...) 获取终态。",
        "event_count": len(events),
    }
    if kind == "article":
        payload["events_url"] = f"/api/runs/{run_id}/events"
    else:
        payload["events_url"] = f"/api/image-runs/{run_id}/events"
    return payload


async def article_run_result(ctx: McpContext, run_id: str) -> dict[str, Any]:
    """Read the completed article run from the repository (source of truth)."""

    version = ctx.repository.get_version_by_run_id(run_id)
    run = ctx.repository.get_run(run_id)
    article = ctx.repository.get_article(run["article_id"])
    result = version_payload(version)
    result["run_id"] = run_id
    result["article"] = article_payload(article)
    return result


async def image_run_result(ctx: McpContext, run_id: str) -> dict[str, Any]:
    """Read a completed image run and ensure the image is saved as an asset."""

    run = ctx.repository.get_image_run(run_id)
    message_id = run.get("assistant_message_id")
    if not message_id:
        raise tool_error("RUN_RESULT_MISSING", "图片运行已完成但缺少结果消息。")
    message = ctx.repository.get_image_message(run["session_id"], message_id)
    if message is None or not message.get("image_url"):
        raise tool_error("RUN_RESULT_MISSING", "图片运行已完成但没有图片地址。")
    title = (run.get("instruction") or message.get("content") or "").strip()
    if not title:
        title = "MCP 生成配图"
    asset = ctx.repository.create_asset(
        source_session_id=run["session_id"],
        source_message_id=message_id,
        title=title[:200],
    )
    result = asset_payload(asset)
    result["asset_id"] = asset["id"]
    result["session_id"] = run["session_id"]
    result["message_id"] = message_id
    result["run_id"] = run_id
    return result
