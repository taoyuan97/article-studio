"""MCP 全链路冒烟：连本地已启动的后端，跑「建文章 → 生成 → 配图 → 排版 → 发布」。

用法（backend 目录下，需先启动后端并开启 MCP）：

    uv run python scripts/mcp_smoke.py --url http://127.0.0.1:8000/mcp/
    uv run python scripts/mcp_smoke.py --url http://127.0.0.1:8000/mcp/ --no-publish

推荐先用假模型服务器（免真实 Key，发布走 fake 模式）：

    uv run python scripts/dev_fake_server.py --port 8000

脚本只调用 MCP 工具，不直接访问数据库；任何一步失败都会打印工具返回并退出非 0。
生成类工具可能等待较久，脚本默认 HTTP 读超时 900s。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

LAYOUT_RATIO = {"landscape": "16:9", "square": "1:1", "portrait": "9:16"}


def _payload(result: Any) -> dict[str, Any]:
    text = "\n".join(
        item.text for item in result.content if getattr(item, "text", None)
    )
    if result.isError:
        raise RuntimeError(text or "MCP tool failed")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"text": text}


async def call(
    session: ClientSession, name: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    print(f"\n▶ {name}({json.dumps(arguments, ensure_ascii=False)})")
    result = await session.call_tool(name, arguments)
    payload = _payload(result)
    preview = json.dumps(payload, ensure_ascii=False)
    print(f"  ← {preview[:600]}{'…' if len(preview) > 600 else ''}")
    return payload


async def run(args: argparse.Namespace) -> None:
    headers = {}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"
    timeout = httpx.Timeout(args.timeout, connect=10.0)
    async with httpx.AsyncClient(headers=headers, timeout=timeout) as http_client:
        async with streamable_http_client(
            args.url, http_client=http_client
        ) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                print(f"✓ MCP 已连接：{args.url}")

                status = await call(session, "studio_status", {})
                if not status["image"]["providers"]:
                    raise RuntimeError(
                        "未配置生图模型：请在设置页配置通义万相，"
                        "或使用 dev_fake_server。"
                    )

                article = await call(session, "create_article", {})
                article_id = article["id"]

                generated = await call(
                    session,
                    "generate_article",
                    {"article_id": article_id, "instruction": args.instruction},
                )
                if generated.get("status") == "running":
                    generated = await call(
                        session,
                        "wait_for_run",
                        {
                            "run_id": generated["run_id"],
                            "kind": "article",
                            "timeout_seconds": args.timeout,
                        },
                    )
                print(
                    f"  ✓ 文章《{generated['title']}》"
                    f"v{generated['version_number']}，"
                    f"{len(generated['content_markdown'])} 字"
                )

                plan = await call(
                    session, "plan_article_images", {"article_id": article_id}
                )
                images = plan["plan"]["images"]

                preview = await call(
                    session, "preview_publish", {"article_id": article_id}
                )
                block_count = len(preview["blocks"])
                placements: list[dict[str, Any]] = []
                assets: list[dict[str, Any]] = []
                for item in images[: args.max_images]:
                    image = await call(
                        session,
                        "generate_image",
                        {
                            "prompt": item["prompt"],
                            "article_id": article_id,
                            "ratio": LAYOUT_RATIO.get(item["layout"], "1:1"),
                        },
                    )
                    assets.append(image)
                    block_index = max(1, min(int(item["block_index"]), block_count))
                    placements.append(
                        {
                            "asset_id": image["asset_id"],
                            "position": f"after_block_{block_index}",
                            "order": len(placements),
                        }
                    )

                cover_id = assets[0]["asset_id"] if assets else None
                preview = await call(
                    session,
                    "preview_publish",
                    {
                        "article_id": article_id,
                        "image_placements": placements,
                        "cover_asset_id": cover_id,
                        "author": args.author,
                    },
                )
                print(
                    f"  ✓ 组装完成：{len(preview['blocks'])} 个块，"
                    f"插图 {len(placements)} 张"
                )

                rendered = await call(
                    session,
                    "render_publish_preview",
                    {
                        "article_id": article_id,
                        "theme_id": args.theme,
                        "image_placements": placements,
                        "cover_asset_id": cover_id,
                        "author": args.author,
                    },
                )
                print(f"  ✓ 渲染预览：{len(rendered['html'])} 字符 HTML")

                if not args.no_publish:
                    published = await call(
                        session,
                        "publish_article",
                        {
                            "article_id": article_id,
                            "theme_id": args.theme,
                            "image_placements": placements,
                            "cover_asset_id": cover_id,
                            "author": args.author,
                        },
                    )
                    print(
                        f"  ✓ 已发布草稿：media_id={published['media_id']} "
                        f"publish_id={published['publish_id']}（未群发）"
                    )

                records = await call(
                    session, "list_publish_records", {"article_id": article_id}
                )
                detail = await call(
                    session, "get_article", {"article_id": article_id}
                )
                print(
                    f"\n✓ 冒烟通过：article_id={article_id}，"
                    f"版本数={len(detail['versions'])}，"
                    f"发布记录={len(records['items'])}"
                )


def main() -> None:
    # Windows 控制台默认 GBK，直接输出中文/符号会 UnicodeEncodeError。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # pragma: no cover - non-reconfigurable streams
            pass
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000/mcp/")
    parser.add_argument(
        "--token", default="", help="MCP_AUTH_TOKEN（未启用鉴权时留空）"
    )
    parser.add_argument(
        "--instruction",
        default="写一篇 1200 字左右的文章，主题是「如何在信息过载中保持专注」，"
        "结构包含引言、三个方法和小结。",
    )
    parser.add_argument("--theme", default="default")
    parser.add_argument("--author", default="Article Studio MCP")
    parser.add_argument("--max-images", type=int, default=3)
    parser.add_argument(
        "--timeout", type=float, default=900.0, help="HTTP 读超时（秒）"
    )
    parser.add_argument("--no-publish", action="store_true", help="只排版不发布")
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
