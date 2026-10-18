"""MCP tools: workspace status and read-only queries."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from .context import (
    McpContext,
    article_payload,
    asset_payload,
    guarded,
    publish_record_payload,
    version_payload,
    wechat_payload,
)


def _clamp_limit(limit: int, maximum: int = 100) -> int:
    return max(1, min(int(limit), maximum))


def register_meta_tools(mcp: FastMCP, ctx: McpContext) -> None:
    @mcp.tool()
    @guarded(ctx)
    def studio_status() -> dict[str, Any]:
        """查看 Article Studio 当前可用能力：语言模型、生图模型、公众号配置与数据统计。

        本地智能体在执行创作/发布前应先调用本工具确认依赖是否就绪。
        """

        settings = ctx.settings
        stats = ctx.repository.get_stats()
        default_llm = settings.provider(settings.default_llm_provider)
        return {
            "server": {
                "name": "article-studio",
                "transport": "streamable-http",
                "endpoint": "/mcp/",
            },
            "llm": {
                "default_provider": settings.default_llm_provider,
                "default_model": default_llm.model,
                "models": ctx.registry.list_models(),
            },
            "image": {
                "default_provider": settings.default_image_provider,
                "providers": ctx.image_registry.list(),
            },
            "wechat": wechat_payload(ctx),
            "publish": {"draft_only": True},
            "waits": {"default_timeout_seconds": settings.mcp_wait_timeout_seconds},
            "stats": {
                "article_count": stats.get("article_count"),
                "asset_count": stats.get("asset_count"),
            },
        }

    @mcp.tool()
    @guarded(ctx)
    def list_articles(limit: int = 20) -> dict[str, Any]:
        """按更新时间倒序列出文章（id/标题/状态/版本数），用于定位 article_id。"""

        items = ctx.repository.list_articles(_clamp_limit(limit))
        return {"items": [article_payload(item) for item in items]}

    @mcp.tool()
    @guarded(ctx)
    def get_article(article_id: str) -> dict[str, Any]:
        """查看文章详情、版本列表与当前版本的完整 Markdown 正文。"""

        article = ctx.repository.get_article(article_id)
        versions = ctx.repository.list_versions(article_id)
        current = None
        if article.get("current_version_id"):
            current = version_payload(
                ctx.repository.get_version(article_id, article["current_version_id"])
            )
        payload = article_payload(article)
        payload["version_count"] = len(versions)
        payload["versions"] = [
            {
                "id": item["id"],
                "version_number": item["version_number"],
                "title": item["title"],
                "created_at": item["created_at"],
            }
            for item in versions
        ]
        payload["current_version"] = current
        return payload

    @mcp.tool()
    @guarded(ctx)
    def list_assets(limit: int = 20) -> dict[str, Any]:
        """列出已保存的图片素材（含可直接用于排版插图和封面的 asset_id）。"""

        items = ctx.repository.list_assets(kind="image", limit=_clamp_limit(limit))
        return {"items": [asset_payload(item) for item in items]}

    @mcp.tool()
    @guarded(ctx)
    def list_publish_records(
        article_id: str | None = None, limit: int = 20
    ) -> dict[str, Any]:
        """查看发布记录（成功/失败、media_id、错误码），可按文章过滤。"""

        items = ctx.repository.list_publish_records(
            article_id=article_id, limit=_clamp_limit(limit)
        )
        return {"items": [publish_record_payload(item) for item in items]}
