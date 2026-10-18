"""FastMCP server exposing Article Studio capabilities to local agents."""

from __future__ import annotations

from fastapi import FastAPI
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from .context import McpContext
from .tools_articles import register_article_tools
from .tools_images import register_image_tools
from .tools_meta import register_meta_tools
from .tools_publish import register_publish_tools

MCP_SERVER_NAME = "article-studio"

INSTRUCTIONS = """\
Article Studio 是一个本地 AI 文章工作台。你可以通过本 MCP 服务完成：
创建文章、生成/写入正文、生成配图素材、按块锚点排版、渲染主题预览，以及发布到
当前已配置的微信公众号草稿箱（只建草稿，不会群发）。

推荐流程：
1. studio_status —— 确认 LLM / 生图 / 公众号是否配置就绪。
2. create_article 或 list_articles/get_article 定位文章。
3. 写正文二选一：
   - generate_article：让后端文章智能体生成/修订（instruction 描述写作或修改要求）；
   - import_article_version：把你写好的 Markdown 定稿直接保存为新版本。
4. 配图：
   - plan_article_images：按文章编排整组配图方案（块锚点 + 排版 + prompt）；
   - generate_image：按 prompt 生成单张图，成功后自动入库并返回 asset_id。
5. 排版：
   - preview_publish：拿到正文 blocks；用 blocks[].index 对应 after_block_{n} 组装插图；
   - list_publish_themes + render_publish_preview：选主题并检查 HTML 预览。
6. publish_article：发布到公众号草稿箱，返回 publish_id / media_id。

超时语义：生成类工具默认等待终态；若超过 timeout_seconds 会返回
{"status": "running", "run_id": ...}，后台不会中断。随后调用
wait_for_run(run_id=..., kind="article"|"image") 继续等待即可。

错误以 `CODE: message` 形式返回（如 PUBLISH_CREDENTIALS_MISSING、
PUBLISH_MCP_ERROR、PLAN_NO_CONTENT、ARTICLE_RUN_ACTIVE、NOT_FOUND）。
工具结果不会包含任何密钥；公众号只返回掩码与配置状态。
"""


def create_mcp_server(application: FastAPI) -> FastMCP:
    """Build the FastMCP server whose tools operate on ``application.state``.

    DNS-rebinding protection is handled by our own ASGI guard middleware
    (Host allowlist + optional bearer token) in ``app.mcp.asgi`` so the policy
    can follow runtime settings instead of being frozen at import time.
    """

    mcp = FastMCP(
        name=MCP_SERVER_NAME,
        instructions=INSTRUCTIONS,
        streamable_http_path="/",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        ),
    )
    ctx = McpContext(application)
    register_meta_tools(mcp, ctx)
    register_article_tools(mcp, ctx)
    register_image_tools(mcp, ctx)
    register_publish_tools(mcp, ctx)
    return mcp
