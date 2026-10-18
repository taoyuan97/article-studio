"""MCP tools: layout preview/rendering and WeChat draft publishing."""

from __future__ import annotations

import asyncio
from typing import Any

from mcp.server.fastmcp import FastMCP
from pydantic import ValidationError

from ..database import NotFoundError
from ..publish_models import ImagePlacement
from ..publish_service import (
    build_publish_markdown,
    execute_publish,
    map_local_paths_to_static,
    split_blocks,
    split_sections,
)
from ..wenyan_client import PublishError
from .context import (
    McpContext,
    guarded,
    resolve_wait_timeout,
    tool_error,
    wechat_payload,
)

_PLACEMENT_HINT = (
    "image_placements 元素为 {asset_id, position, order?}；position 使用 "
    "blocks[].index 对应的 after_block_{n}，也支持 top/bottom/after_section_{n}。"
)


def _normalize_placements(
    placements: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    validated: list[dict[str, Any]] = []
    for index, item in enumerate(placements or []):
        try:
            validated.append(ImagePlacement.model_validate(item).model_dump())
        except ValidationError as exc:
            detail = exc.errors()[0].get("msg", "参数非法")
            raise tool_error(
                "INVALID_ARGUMENT", f"image_placements[{index}] 非法：{detail}"
            ) from exc
    return validated


def _resolve_version(
    ctx: McpContext, article_id: str, version_id: str | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    article = ctx.repository.get_article(article_id)
    resolved = version_id or article.get("current_version_id")
    if not resolved:
        raise tool_error("PUBLISH_NO_CONTENT", "该文章尚无可用版本，请先生成文章内容。")
    version = ctx.repository.get_version(article_id, resolved)
    return article, version


def _collect_assets(
    ctx: McpContext,
    placements: list[dict[str, Any]],
    cover_asset_id: str | None,
) -> dict[str, dict[str, Any]]:
    asset_ids = {item["asset_id"] for item in placements}
    if cover_asset_id:
        asset_ids.add(cover_asset_id)
    assets: dict[str, dict[str, Any]] = {}
    for asset_id in asset_ids:
        try:
            assets[asset_id] = ctx.repository.get_asset(asset_id)
        except NotFoundError:
            raise tool_error(
                "PUBLISH_ASSET_MISSING", f"图片素材不存在：{asset_id}"
            ) from None
    return assets


def _assemble_markdown(
    ctx: McpContext,
    article: dict[str, Any],
    version: dict[str, Any],
    placements: list[dict[str, Any]],
    cover_asset_id: str | None,
    author: str | None,
) -> tuple[str, dict[str, dict[str, Any]]]:
    assets = _collect_assets(ctx, placements, cover_asset_id)
    try:
        markdown = build_publish_markdown(
            title=version["title"] or article["title"],
            content_markdown=version["content_markdown"],
            image_placements=placements,
            assets=assets,
            cover_asset_id=cover_asset_id,
            author=author,
            data_dir=ctx.data_dir,
        )
    except PublishError as exc:
        raise tool_error(exc.code, ctx.redact(exc.message)) from exc
    return markdown, assets


def register_publish_tools(mcp: FastMCP, ctx: McpContext) -> None:
    @mcp.tool()
    @guarded(ctx)
    async def list_publish_themes() -> dict[str, Any]:
        """列出 wenyan 排版主题（id/name/description），供 render/publish 选择 theme_id。"""

        try:
            themes = await ctx.wenyan_client.list_themes()
        except PublishError as exc:
            raise tool_error(exc.code, ctx.redact(exc.message)) from exc
        return {"items": themes}

    @mcp.tool()
    @guarded(ctx)
    async def preview_publish(
        article_id: str,
        version_id: str | None = None,
        image_placements: list[dict[str, Any]] | None = None,
        cover_asset_id: str | None = None,
        author: str | None = None,
        digest: str | None = None,
    ) -> dict[str, Any]:
        """排版预览：返回正文块清单（插图锚点）与组装后的发布 Markdown。

        先用 blocks[].index 确认每张配图要插在第几个块后，再把同样的
        image_placements 传给 render_publish_preview / publish_article。
        digest 仅随发布记录保存（当前草稿阶段不写入微信摘要）。
        """

        placements = _normalize_placements(image_placements)
        article, version = _resolve_version(ctx, article_id, version_id)
        markdown, _assets = _assemble_markdown(
            ctx, article, version, placements, cover_asset_id, author
        )
        return {
            "article_id": article["id"],
            "version_id": version["id"],
            "title": version["title"] or article["title"],
            "blocks": split_blocks(version["content_markdown"]),
            "sections": split_sections(version["content_markdown"]),
            "markdown": markdown,
            "placement_hint": _PLACEMENT_HINT,
        }

    @mcp.tool()
    @guarded(ctx)
    async def render_publish_preview(
        article_id: str,
        theme_id: str,
        version_id: str | None = None,
        image_placements: list[dict[str, Any]] | None = None,
        cover_asset_id: str | None = None,
        author: str | None = None,
        digest: str | None = None,
        markdown: str | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        """用与真实发布完全一致的渲染引擎生成主题 HTML 预览。

        theme_id 来自 list_publish_themes；markdown 可选，用于渲染人工编辑后的终稿
        （提供时跳过组装）。返回的 html 可直接嵌入/截图检查排版效果。
        """

        theme = (theme_id or "").strip()
        if not theme:
            raise tool_error("PUBLISH_THEME_MISSING", "发布主题（theme_id）不能为空。")
        placements = _normalize_placements(image_placements)
        article, version = _resolve_version(ctx, article_id, version_id)
        if markdown is not None and markdown.strip():
            content = markdown
            assets = _collect_assets(ctx, placements, cover_asset_id)
        else:
            content, assets = _assemble_markdown(
                ctx, article, version, placements, cover_asset_id, author
            )
        mapped = map_local_paths_to_static(content, assets, ctx.data_dir)
        timeout = resolve_wait_timeout(ctx, timeout_seconds)
        try:
            html = await asyncio.wait_for(
                ctx.wenyan_client.render_markdown(mapped, theme), timeout=timeout
            )
        except TimeoutError:
            raise tool_error(
                "PUBLISH_RENDER_TIMEOUT", "主题预览渲染超时，请稍后重试。"
            ) from None
        except PublishError as exc:
            raise tool_error(exc.code, ctx.redact(exc.message)) from exc
        return {
            "article_id": article["id"],
            "version_id": version["id"],
            "theme_id": theme,
            "html": html,
        }

    @mcp.tool()
    @guarded(ctx)
    async def publish_article(
        article_id: str,
        theme_id: str,
        version_id: str | None = None,
        image_placements: list[dict[str, Any]] | None = None,
        cover_asset_id: str | None = None,
        author: str | None = None,
        digest: str | None = None,
        edited_markdown: str | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        """把文章（含封面、正文插图和主题）发布到公众号草稿箱。

        只创建草稿，不会群发；发布成功返回 media_id，失败会落发布记录并抛结构化错误。
        微信要求封面或正文至少一张图：没有配图时请同时提供 cover_asset_id。
        edited_markdown 可选，提供时按人工终稿发布（跳过自动组装）。
        """

        theme = (theme_id or "").strip()
        if not theme:
            raise tool_error("PUBLISH_THEME_MISSING", "发布主题（theme_id）不能为空。")
        placements = _normalize_placements(image_placements)
        timeout = resolve_wait_timeout(ctx, timeout_seconds)
        try:
            result = await asyncio.wait_for(
                execute_publish(
                    repository=ctx.repository,
                    client=ctx.wenyan_client,
                    article_id=article_id,
                    theme_id=theme,
                    version_id=version_id,
                    image_placements=placements,
                    cover_asset_id=cover_asset_id,
                    author=author,
                    digest=digest,
                    edited_markdown=edited_markdown,
                    data_dir=ctx.data_dir,
                ),
                timeout=timeout,
            )
        except TimeoutError:
            raise tool_error(
                "PUBLISH_TIMEOUT", "发布超时，请稍后在发布记录中查看结果。"
            ) from None
        except PublishError as exc:
            raise tool_error(exc.code, ctx.redact(exc.message)) from exc
        except NotFoundError as exc:
            raise tool_error("NOT_FOUND", str(exc)) from exc
        result["wechat"] = wechat_payload(ctx)
        result["draft_only"] = True
        return result
