"""ASGI wiring for the MCP server: mount + runtime access guard.

The MCP endpoint is mounted unconditionally and gated per request, because the
effective runtime settings (``MCP_ENABLED`` and friends) are resolved in the
FastAPI lifespan — after routes have to be registered. A pure ASGI middleware
keeps the gate in front of routing and also normalises ``/mcp`` to ``/mcp/``
(MCP clients do not follow the 307 redirect produced by a Starlette Mount).
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from .server import create_mcp_server

MCP_MOUNT_PATH = "/mcp"


@dataclass(slots=True)
class McpServerBundle:
    server: Any
    app: Any

    @asynccontextmanager
    async def lifespan(self):
        """Run the MCP sub-app lifespan inside a dedicated long-lived task.

        Starlette does not run mounted sub-app lifespans, and the MCP session
        manager uses an anyio task group whose cancel scope must be entered and
        exited in the same task. Running it in its own task also keeps host
        lifespans (and pytest-asyncio fixtures) free of that constraint.
        """

        ready = asyncio.Event()
        stop = asyncio.Event()
        failure: list[BaseException] = []

        async def runner() -> None:
            try:
                async with self.app.router.lifespan_context(self.app):
                    ready.set()
                    await stop.wait()
            except BaseException as exc:  # pragma: no cover - startup failure path
                failure.append(exc)
                ready.set()

        task = asyncio.create_task(runner(), name="article-studio-mcp-lifespan")
        await ready.wait()
        if failure:
            raise failure[0]
        try:
            yield
        finally:
            stop.set()
            await task


def build_mcp_bundle(application: FastAPI) -> McpServerBundle:
    server = create_mcp_server(application)
    return McpServerBundle(server=server, app=server.streamable_http_app())


async def _send_json(
    send: Send,
    status_code: int,
    payload: dict[str, Any],
    *,
    extra_headers: list[tuple[bytes, bytes]] | None = None,
) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = [
        (b"content-type", b"application/json; charset=utf-8"),
        (b"content-length", str(len(body)).encode("ascii")),
        (b"cache-control", b"no-store"),
        *(extra_headers or []),
    ]
    await send(
        {"type": "http.response.start", "status": status_code, "headers": headers}
    )
    await send({"type": "http.response.body", "body": body})


def _mcp_error(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


class McpGuardMiddleware:
    """Gate ``/mcp`` requests by enabled flag, Host allowlist and bearer token."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if path != MCP_MOUNT_PATH and not path.startswith(MCP_MOUNT_PATH + "/"):
            await self.app(scope, receive, send)
            return

        application = scope.get("app")
        state = getattr(application, "state", None)
        settings = getattr(state, "settings", None)
        if settings is None or not settings.mcp_enabled:
            await _send_json(
                send,
                404,
                _mcp_error(
                    "MCP_DISABLED",
                    "MCP 未开启；请在 backend/.env 设置 MCP_ENABLED=true 后重启后端。",
                ),
            )
            return

        headers = Headers(scope=scope)
        host = (headers.get("host") or "").strip().lower()
        hostname = urlsplit(f"//{host}").hostname or ""
        allowed_hosts = {
            item.strip().lower()
            for item in settings.mcp_allowed_hosts.split(",")
            if item.strip()
        }
        if hostname not in allowed_hosts:
            await _send_json(
                send,
                403,
                _mcp_error(
                    "MCP_HOST_FORBIDDEN",
                    f"Host {hostname or '(missing)'} 不在 MCP_ALLOWED_HOSTS 白名单内。",
                ),
            )
            return

        origin = (headers.get("origin") or "").strip()
        if origin:
            origin_host = urlsplit(origin).hostname or ""
            if origin_host not in allowed_hosts:
                await _send_json(
                    send,
                    403,
                    _mcp_error(
                        "MCP_ORIGIN_FORBIDDEN",
                        f"Origin {origin_host or '(invalid)'} 不在 Host 白名单内。",
                    ),
                )
                return

        token = settings.mcp_auth_token
        if token is not None:
            expected = f"Bearer {token.get_secret_value()}"
            if (headers.get("authorization") or "") != expected:
                await _send_json(
                    send,
                    401,
                    _mcp_error("MCP_UNAUTHORIZED", "缺少或错误的 MCP Bearer Token。"),
                    extra_headers=[(b"www-authenticate", b"Bearer")],
                )
                return

        if path == MCP_MOUNT_PATH:
            normalised = dict(scope)
            normalised["path"] = MCP_MOUNT_PATH + "/"
            await self.app(normalised, receive, send)
            return
        await self.app(scope, receive, send)
