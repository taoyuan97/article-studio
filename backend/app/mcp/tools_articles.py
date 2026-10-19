"""MCP tools: article creation, generation, version import and run waiting."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from ..database import NotFoundError, RunNotActiveError
from .context import (
    ARTICLE_TERMINAL_EVENTS,
    IMAGE_TERMINAL_EVENTS,
    McpContext,
    article_payload,
    article_run_result,
    collect_run_events,
    find_event,
    guarded,
    image_run_result,
    resolve_llm_selection,
    resolve_wait_timeout,
    running_payload,
    tool_error,
    version_payload,
)

_STATUS_TEXT = {
    "failed": "运行失败",
    "cancelled": "运行已取消",
    "completed": "运行未产出文章版本",
}


def _run_failure(ctx: McpContext, run_id: str, events: list[Any]) -> None:
    """Raise a structured error if the collected events show a failed run."""

    failed = find_event(events, "run.failed")
    if failed is not None:
        run = ctx.repository.get_run(run_id)
        code = run.get("error_code") or failed.data.get("error_type") or "ARTICLE_RUN_FAILED"
        message = failed.data.get("message") or run.get("error_message") or "文章生成失败"
        raise tool_error(str(code), ctx.redact(message))
    if find_event(events, "run.cancelled") is not None:
        raise tool_error("RUN_CANCELLED", "文章运行已取消，未保存版本。")


async def _article_terminal_result(
    ctx: McpContext, run_id: str, events: list[Any]
) -> dict[str, Any]:
    _run_failure(ctx, run_id, events)
    try:
        return await article_run_result(ctx, run_id)
    except NotFoundError as exc:
        raise tool_error("RUN_RESULT_MISSING", f"未找到运行产出：{exc}") from exc


def _resolve_article_version(
    ctx: McpContext, article: dict[str, Any], version_id: str | None
) -> dict[str, Any]:
    resolved = version_id or article.get("current_version_id")
    if not resolved:
        raise tool_error("NO_CONTENT", "该文章尚无可用版本，请先生成文章内容。")
    return ctx.repository.get_version(article["id"], resolved)


def register_article_tools(mcp: FastMCP, ctx: McpContext) -> None:
    @mcp.tool()
    @guarded(ctx)
    def create_article(
        provider: str | None = None, model: str | None = None
    ) -> dict[str, Any]:
        """新建一篇文章草稿，返回 article_id。

        provider/model 缺省时使用设置页的默认语言模型；新建后可用
        generate_article 让后端智能体写作，或 import_article_version 直接写入定稿。
        """

        resolved_provider, resolved_model = resolve_llm_selection(ctx, provider, model)
        article = ctx.repository.create_article(resolved_provider, resolved_model)
        return article_payload(article)

    @mcp.tool()
    @guarded(ctx)
    async def generate_article(
        article_id: str,
        instruction: str,
        provider: str | None = None,
        model: str | None = None,
        wait: bool = True,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        """让 Article Studio 的文章智能体生成/修订正文并落一个新版本。

        instruction 是写作或修改指令（如「写一篇关于专注的 2000 字文章」）。
        wait=true 时等待到终态；超过 timeout_seconds 返回 {status:"running", run_id}，
        可以稍后用 wait_for_run 续等。运行中同一文章不能重复提交。
        """

        text = instruction.strip()
        if not text:
            raise tool_error("INVALID_ARGUMENT", "instruction 不能为空")
        timeout = resolve_wait_timeout(ctx, timeout_seconds)

        article = ctx.repository.get_article(article_id)
        if provider is not None or model is not None:
            resolved_provider, resolved_model = resolve_llm_selection(ctx, provider, model)
            if (article["provider"], article["model"]) != (
                resolved_provider,
                resolved_model,
            ):
                if ctx.manager.is_active(article_id):
                    raise tool_error(
                        "ARTICLE_RUN_ACTIVE", "文章正在生成中，不能切换模型。"
                    )
                article = ctx.repository.update_model(
                    article_id, resolved_provider, resolved_model
                )
        if ctx.manager.is_active(article_id):
            raise tool_error(
                "ARTICLE_RUN_ACTIVE",
                "该文章已有生成任务在运行，请等待完成后重试。",
            )

        try:
            run = await ctx.manager.start(article_id, content=text)
        except RunNotActiveError as exc:
            raise tool_error("ARTICLE_RUN_ACTIVE", str(exc)) from exc
        except NotFoundError as exc:
            raise tool_error("NOT_FOUND", str(exc)) from exc

        run_id = run["id"]
        if not wait:
            return running_payload(run_id, "article", [])
        events, timed_out = await collect_run_events(
            ctx.manager, run_id, timeout, ARTICLE_TERMINAL_EVENTS
        )
        if timed_out:
            return running_payload(run_id, "article", events)
        return await _article_terminal_result(ctx, run_id, events)

    @mcp.tool()
    @guarded(ctx)
    def import_article_version(
        article_id: str,
        title: str,
        content_markdown: str,
        instruction: str | None = None,
    ) -> dict[str, Any]:
        """直接把智能体写好的 Markdown 定稿保存为文章新版本（不调用后端模型）。

        适用于「智能体自己写正文，只借用 Article Studio 的配图/排版/发布」的场景。
        title 为文章标题；content_markdown 为完整正文；instruction 可选，记录来源说明。
        """

        clean_title = title.strip()
        content = content_markdown.strip()
        if not clean_title:
            raise tool_error("INVALID_ARGUMENT", "title 不能为空")
        if len(clean_title) > 200:
            raise tool_error("INVALID_ARGUMENT", "title 不能超过 200 字")
        if not content:
            raise tool_error("INVALID_ARGUMENT", "content_markdown 不能为空")
        if len(content) > 200_000:
            raise tool_error("INVALID_ARGUMENT", "content_markdown 不能超过 200,000 字符")
        ctx.repository.get_article(article_id)
        try:
            version, _message = ctx.repository.create_imported_version(
                article_id,
                title=clean_title,
                content_markdown=content,
                instruction=instruction,
            )
        except RunNotActiveError as exc:
            raise tool_error(
                "ARTICLE_RUN_ACTIVE",
                "该文章已有生成任务在运行，请等待完成后再导入定稿。",
            ) from exc
        except NotFoundError as exc:
            raise tool_error("NOT_FOUND", str(exc)) from exc
        payload = version_payload(version)
        payload["article"] = article_payload(ctx.repository.get_article(article_id))
        return payload

    @mcp.tool()
    @guarded(ctx)
    def get_article_version(
        article_id: str, version_id: str | None = None
    ) -> dict[str, Any]:
        """读取文章版本正文；version_id 缺省时返回当前版本。"""

        article = ctx.repository.get_article(article_id)
        version = _resolve_article_version(ctx, article, version_id)
        payload = version_payload(version)
        payload["is_current"] = version["id"] == article.get("current_version_id")
        return payload

    @mcp.tool()
    @guarded(ctx)
    async def wait_for_run(
        run_id: str,
        kind: str = "article",
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        """等待一个文章（kind=article）或配图（kind=image）运行到终态。

        用于 generate_article / generate_image 超时返回 running 后继续等待。
        成功返回版本/素材结果；失败或取消返回结构化错误；仍超时返回 running。
        """

        if kind not in {"article", "image"}:
            raise tool_error("INVALID_ARGUMENT", "kind 必须是 article 或 image")
        timeout = resolve_wait_timeout(ctx, timeout_seconds)

        if kind == "article":
            events, timed_out = await collect_run_events(
                ctx.manager, run_id, timeout, ARTICLE_TERMINAL_EVENTS
            )
            if timed_out:
                return running_payload(run_id, "article", events)
            _run_failure(ctx, run_id, events)
            try:
                return await article_run_result(ctx, run_id)
            except NotFoundError as exc:
                run = ctx.repository.get_run(run_id)
                status = run.get("status", "unknown")
                raise tool_error(
                    "RUN_NOT_FINISHED",
                    f"{_STATUS_TEXT.get(status, status)}（run_id={run_id}）",
                ) from exc

        events, timed_out = await collect_run_events(
            ctx.image_manager, run_id, timeout, IMAGE_TERMINAL_EVENTS
        )
        if timed_out:
            return running_payload(run_id, "image", events)
        failed = find_event(events, "image.failed")
        run = ctx.repository.get_image_run(run_id)
        if failed is not None or run.get("status") == "failed":
            code = failed.data.get("error_type") if failed else None
            message = (
                (failed.data.get("message") if failed else None)
                or run.get("error_message")
                or "图片生成失败"
            )
            raise tool_error(
                str(code or "IMAGE_GENERATION_FAILED"), ctx.redact(message)
            )
        if find_event(events, "run.cancelled") is not None or run.get("status") == "cancelled":
            raise tool_error("RUN_CANCELLED", "配图运行已取消，未生成图片。")
        if run.get("status") != "completed":
            raise tool_error(
                "RUN_NOT_FINISHED",
                f"图片运行尚未完成（状态：{run.get('status', 'unknown')}）",
            )
        return await image_run_result(ctx, run_id)
