"""MCP 配置自检：连接本地 `/mcp/`，initialize、列工具、调用 studio_status。

只做只读检查，不生成文章/图片、不发布，适合配置完成后快速确认。
用法（backend 目录下）：

    uv run python scripts/mcp_selftest.py
    uv run python scripts/mcp_selftest.py --url http://127.0.0.1:8000/mcp/ --token <token>
    uv run python scripts/mcp_selftest.py --json

退出码：0 = 连接成功且工具清单符合预期；1 = 连接/协议/工具清单异常。
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

EXPECTED_TOOLS = {
    "studio_status",
    "list_articles",
    "get_article",
    "list_assets",
    "list_publish_records",
    "create_article",
    "generate_article",
    "import_article_version",
    "get_article_version",
    "wait_for_run",
    "generate_image",
    "plan_article_images",
    "list_publish_themes",
    "preview_publish",
    "render_publish_preview",
    "publish_article",
}


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


_PREFLIGHT_PAYLOAD = {
    "jsonrpc": "2.0",
    "id": 0,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "article-studio-selftest", "version": "0"},
    },
}

_STATUS_HINTS = {
    404: "MCP 未开启或端点错误：确认 backend/.env 设置 MCP_ENABLED=true，"
    "从 backend 目录启动/重启后端；关闭时 /mcp* 统一 404。",
    401: "缺少或错误的 Bearer Token：检查 MCP_AUTH_TOKEN 与客户端 "
    "Authorization: Bearer <token> 是否一致。",
    403: "Host/Origin 不在 MCP_ALLOWED_HOSTS 白名单：用 127.0.0.1/localhost "
    "访问，或把实际主机名加入白名单。",
    421: "Host 头不被接受：确认 URL 是 http://127.0.0.1:8000/mcp/。",
}


async def _preflight(client: httpx.AsyncClient, url: str) -> str | None:
    """Probe HTTP status before the MCP handshake (client hides 404/401/403)."""

    try:
        response = await client.post(
            url,
            json=_PREFLIGHT_PAYLOAD,
            headers={"Accept": "application/json, text/event-stream"},
        )
    except httpx.ConnectError:
        return "无法连接后端：确认后端已启动、端口正确（默认 8000），并检查防火墙/代理。"
    except httpx.TimeoutException:
        return "连接超时：检查后端日志与端口占用。"
    if response.status_code in _STATUS_HINTS:
        return f"[HTTP {response.status_code}] " + _STATUS_HINTS[response.status_code]
    if response.status_code >= 400:
        return f"[HTTP {response.status_code}] MCP 端点返回异常状态码。"
    return None


def _walk_exceptions(exc: BaseException) -> list[BaseException]:
    seen: list[BaseException] = []
    stack = [exc]
    while stack:
        current = stack.pop()
        seen.append(current)
        for sub in getattr(current, "exceptions", ()) or ():
            stack.append(sub)
    return seen


def _diagnose(exc: BaseException) -> str:
    """Turn the MCP client's ExceptionGroup into an actionable hint."""

    hints = {
        404: "MCP 未开启或端点错误：确认 backend/.env 设置 MCP_ENABLED=true，"
        "从 backend 目录启动/重启后端；关闭时 /mcp* 统一 404。",
        401: "缺少或错误的 Bearer Token：检查 MCP_AUTH_TOKEN 与客户端 "
        "Authorization: Bearer <token> 是否一致。",
        403: "Host/Origin 不在 MCP_ALLOWED_HOSTS 白名单：用 127.0.0.1/localhost "
        "访问，或把实际主机名加入白名单。",
        421: "Host 头不被接受：确认 URL 是 http://127.0.0.1:8000/mcp/。",
    }
    for item in _walk_exceptions(exc):
        if isinstance(item, httpx.HTTPStatusError):
            status = item.response.status_code
            return f"[HTTP {status}] " + hints.get(
                status, f"MCP 端点返回 HTTP {status}。"
            )
        if isinstance(item, httpx.ConnectError):
            return (
                "无法连接后端：确认后端已启动、端口正确（默认 8000），"
                "并检查防火墙/代理。"
            )
        if isinstance(item, httpx.TimeoutException):
            return "连接或读取超时：检查后端日志与端口占用。"
    return f"{type(exc).__name__}: {exc}"


async def run(args: argparse.Namespace) -> int:
    headers = {}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"
    timeout = httpx.Timeout(args.timeout, connect=10.0)
    try:
        async with httpx.AsyncClient(headers=headers, timeout=timeout) as http_client:
            preflight_error = await _preflight(http_client, args.url)
            if preflight_error:
                print(f"✗ MCP 自检失败：{preflight_error}", file=sys.stderr)
                return 1
            async with streamable_http_client(
                args.url, http_client=http_client
            ) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    names = {tool.name for tool in tools.tools}
                    status = _payload(
                        await session.call_tool("studio_status", {})
                    )
    except Exception as exc:  # network / HTTP / protocol errors
        print(f"✗ MCP 自检失败：{_diagnose(exc)}", file=sys.stderr)
        return 1

    missing = EXPECTED_TOOLS - names
    extra = names - EXPECTED_TOOLS
    ok = not missing and not extra

    summary = {
        "ok": ok,
        "url": args.url,
        "tool_count": len(names),
        "missing_tools": sorted(missing),
        "unexpected_tools": sorted(extra),
        "llm": status.get("llm"),
        "image": status.get("image"),
        "wechat": status.get("wechat"),
        "waits": status.get("waits"),
    }

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0 if ok else 1

    print(f"✓ 已连接 MCP：{args.url}")
    print(f"✓ 工具清单：{len(names)} 个（预期 {len(EXPECTED_TOOLS)} 个）")
    if missing:
        print(f"  ✗ 缺少工具：{', '.join(sorted(missing))}")
    if extra:
        print(f"  ⚠ 额外工具：{', '.join(sorted(extra))}")
    llm = status.get("llm") or {}
    print(
        f"  LLM：{llm.get('default_provider')}/{llm.get('default_model')}"
        f"（可用模型 {len(llm.get('models') or [])} 个）"
    )
    image = status.get("image") or {}
    providers = image.get("providers") or []
    print(
        "  生图："
        + (
            ", ".join(f"{item.get('provider')}/{item.get('model')}" for item in providers)
            if providers
            else "未配置（配图工具不可用）"
        )
    )
    wechat = status.get("wechat") or {}
    print(
        f"  公众号：{'已配置' if wechat.get('configured') else '未配置'}"
        f"，fake 模式={wechat.get('publish_fake_mode')}，仅草稿={wechat.get('draft_only')}"
    )
    waits = status.get("waits") or {}
    print(f"  默认等待：{waits.get('default_timeout_seconds')}s")
    print("✓ 自检通过" if ok else "✗ 自检未通过：工具清单与预期不一致")
    return 0 if ok else 1


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # pragma: no cover
            pass
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000/mcp/")
    parser.add_argument("--token", default="", help="MCP_AUTH_TOKEN（未启用鉴权时留空）")
    parser.add_argument("--timeout", type=float, default=60.0, help="HTTP 读超时（秒）")
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
