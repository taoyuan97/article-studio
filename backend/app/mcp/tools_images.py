"""MCP tools: image generation and the T015 image plan mode."""

from __future__ import annotations

import asyncio
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError

from article_agent.image_providers import resolve_image_size

from ..database import NotFoundError, RunNotActiveError
from ..plan_service import PlanError, generate_image_plan
from .context import (
    IMAGE_TERMINAL_EVENTS,
    McpContext,
    collect_run_events,
    find_event,
    guarded,
    image_run_result,
    resolve_image_selection,
    resolve_llm_selection,
    resolve_wait_timeout,
    running_payload,
    tool_error,
)


async def _image_terminal_result(
    ctx: McpContext, run_id: str
) -> dict[str, Any]:
    run = ctx.repository.get_image_run(run_id)
    if run.get("status") == "failed":
        raise tool_error(
            "IMAGE_GENERATION_FAILED",
            ctx.redact(run.get("error_message") or "图片生成失败"),
        )
    if run.get("status") == "cancelled":
        raise tool_error("RUN_CANCELLED", "配图运行已取消，未生成图片。")
    if run.get("status") != "completed":
        raise tool_error(
            "RUN_NOT_FINISHED",
            f"图片运行尚未完成（状态：{run.get('status', 'unknown')}）",
        )
    return await image_run_result(ctx, run_id)


def register_image_tools(mcp: FastMCP, ctx: McpContext) -> None:
    @mcp.tool()
    @guarded(ctx)
    async def generate_image(
        prompt: str,
        article_id: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        tier: str | None = None,
        ratio: str | None = None,
        wait: bool = True,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        """按提示词生成配图，成功后自动保存为素材并返回 asset_id。

        provider/model 缺省时使用设置页配置的生图模型；tier/ratio 缺省为 2K/1:1。
        article_id 可选，用于把配图会话关联到文章。返回的 asset_id 可直接用于
        preview_publish/publish_article 的 image_placements 与 cover_asset_id。
        """

        text = prompt.strip()
        if not text:
            raise tool_error("INVALID_ARGUMENT", "prompt 不能为空")
        resolved_provider, resolved_model = resolve_image_selection(
            ctx, provider, model
        )
        resolved_tier = (tier or "2K").strip()
        resolved_ratio = (ratio or "1:1").strip()
        try:
            resolve_image_size(resolved_provider, resolved_tier, resolved_ratio)
        except ValueError as exc:
            raise tool_error("IMAGE_PARAMS_INVALID", str(exc)) from exc
        if article_id:
            ctx.repository.get_article(article_id)

        timeout = resolve_wait_timeout(ctx, timeout_seconds)
        session = ctx.repository.create_image_session(
            provider=resolved_provider,
            model=resolved_model,
            article_id=article_id,
        )
        ctx.repository.update_image_session_title(session["id"], text[:60])
        try:
            run = await ctx.image_manager.start(
                session["id"],
                content=text,
                provider=resolved_provider,
                model=resolved_model,
                tier=resolved_tier,
                ratio=resolved_ratio,
            )
        except RunNotActiveError as exc:
            raise tool_error("IMAGE_RUN_ACTIVE", str(exc)) from exc
        except NotFoundError as exc:
            raise tool_error("NOT_FOUND", str(exc)) from exc

        run_id = run["id"]
        if not wait:
            return running_payload(run_id, "image", [])
        events, timed_out = await collect_run_events(
            ctx.image_manager, run_id, timeout, IMAGE_TERMINAL_EVENTS
        )
        if timed_out:
            return running_payload(run_id, "image", events)
        failed = find_event(events, "image.failed")
        if failed is not None:
            raise tool_error(
                "IMAGE_GENERATION_FAILED",
                ctx.redact(failed.data.get("message") or "图片生成失败"),
            )
        if find_event(events, "run.cancelled") is not None:
            raise tool_error("RUN_CANCELLED", "配图运行已取消，未生成图片。")
        result = await _image_terminal_result(ctx, run_id)
        result["session_id"] = session["id"]
        return result

    @mcp.tool()
    @guarded(ctx)
    async def plan_article_images(
        article_id: str,
        version_id: str | None = None,
        role: str | None = None,
        instructions: str | None = None,
        provider: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        """按 T015 配图计划为文章编排配图方案（块锚点 + 排版建议 + 提示词）。

        返回的 images[].block_index 与 preview_publish 返回的 blocks[].index 一致，
        可直接把生成的图片按 after_block_{n} 插入正文。方案会持久化到配图会话。
        """

        article = ctx.repository.get_article(article_id)
        resolved_provider, resolved_model = resolve_llm_selection(ctx, provider, model)
        try:
            image_provider, image_model = resolve_image_selection(ctx, None, None)
        except ToolError:
            image_provider, image_model = "aliyun_wanxiang", "unconfigured"
        session = ctx.repository.create_image_session(
            provider=image_provider,
            model=image_model,
            article_id=article["id"],
        )
        ctx.repository.update_image_session_title(session["id"], "MCP 配图方案")
        try:
            payload = await asyncio.wait_for(
                generate_image_plan(
                    registry=ctx.registry,
                    repository=ctx.repository,
                    session_id=session["id"],
                    article_id=article_id,
                    version_id=version_id,
                    role=role,
                    instructions=instructions,
                    provider=resolved_provider,
                    model=resolved_model,
                    secret_values=ctx.secret_values,
                ),
                timeout=120,
            )
        except TimeoutError:
            raise tool_error(
                "PLAN_TIMEOUT", "配图编排超时（120s），请稍后重试。"
            ) from None
        except PlanError as exc:
            raise tool_error(exc.code, ctx.redact(exc.message)) from exc
        except NotFoundError as exc:
            raise tool_error("NOT_FOUND", str(exc)) from exc
        payload["session_id"] = session["id"]
        return payload
