"""MCP client wrapper for wenyan-mcp (WeChat Official Account publishing).

Spawns `wenyan-mcp` as a stdio subprocess on demand (no persistent
connection), calls the `list_themes` / `publish_article` tools, and converts
failures into structured domain errors. Provides a fake mode for development
and tests that never spawns a subprocess nor touches the WeChat API.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import shutil
import uuid
from pathlib import Path
from typing import Any

from article_agent.config import Settings


# Built-in themes of wenyan-mcp, used by fake mode. Keep ids in sync with
# @wenyan-md/mcp (see publish_article tool description).
FAKE_BUILTIN_THEMES: list[dict[str, str]] = [
    {"id": "default", "name": "Default", "description": "默认主题，简洁经典的排版，适合长文阅读。"},
    {"id": "orangeheart", "name": "OrangeHeart", "description": "暖橙色调，优雅而富有活力，适合情感、生活类内容。"},
    {"id": "rainbow", "name": "Rainbow", "description": "色彩明快，层次分明，适合教程与技术分享。"},
    {"id": "lapis", "name": "Lapis", "description": "清爽蓝色调，阅读体验舒适，适合知识类长文。"},
    {"id": "pie", "name": "Pie", "description": "轻盈柔和的风格，适合随笔与轻内容。"},
    {"id": "maize", "name": "Maize", "description": "玉米暖色系，温暖质朴，适合叙事类文章。"},
    {"id": "purple", "name": "Purple", "description": "紫色雅致风格，适合观点与评论类内容。"},
    {"id": "phycat", "name": "Phycat", "description": "物理猫薄荷主题，清新极客风，适合科技类文章。"},
]

# wenyan-mcp returns plain text on success, e.g.
# "Your article was successfully published to '公众号草稿箱'. The media ID is xxx."
_MEDIA_ID_PATTERN = re.compile(r"The media ID is (\S+)")
# Tool failures come back as "执行工具失败: ..." text.
_TOOL_FAILURE_MARKER = "执行工具失败"

# Fake-mode failure injection: dev_fake_server embeds this marker into the
# generated article when the user message contains it, so E2E / manual smoke
# tests can exercise the failed-publish path (record + retry) without real
# WeChat credentials. See scripts/dev_fake_server.py.
FAKE_PUBLISH_FAILURE_MARKER = "触发发布失败"


class PublishError(Exception):
    """Domain error with a structured code/message for the API layer."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


def extract_media_id(text: str) -> str | None:
    """Extract the media id from a wenyan-mcp publish_article result text."""
    match = _MEDIA_ID_PATTERN.search(text)
    if match is None:
        return None
    return match.group(1).rstrip(".")


class WenyanMcpClient:
    """On-demand stdio client for wenyan-mcp with a fake mode."""

    def __init__(
        self,
        settings: Settings,
        *,
        timeout: float = 120.0,
        data_dir: Path | None = None,
    ) -> None:
        self._settings = settings
        self._timeout = timeout
        self._data_dir = data_dir

    @property
    def fake_mode(self) -> bool:
        return self._settings.publish_fake_mode

    def _require_credentials(self) -> None:
        if not self._settings.wechat_app_id or not self._settings.wechat_app_secret:
            raise PublishError(
                "PUBLISH_CREDENTIALS_MISSING",
                "未配置公众号凭据，请在 .env 中设置 WECHAT_APP_ID 与 WECHAT_APP_SECRET。",
            )

    def _server_command(self) -> tuple[str, list[str]]:
        """Resolve the configured command into an executable path + args.

        On Windows, npm installs a `wenyan-mcp.cmd` shim; `shutil.which`
        resolves it ( honouring PATHEXT ) so we never execute the shim shell
        script directly.
        """
        raw = self._settings.wenyan_mcp_command.strip()
        if not raw:
            raise PublishError("PUBLISH_MCP_NOT_INSTALLED", "WENYAN_MCP_COMMAND 未配置。")
        try:
            parts = shlex.split(raw, posix=os.name != "nt")
        except ValueError:
            parts = raw.split()
        parts = [part.strip('"') for part in parts if part.strip('"')]
        if not parts:
            raise PublishError("PUBLISH_MCP_NOT_INSTALLED", "WENYAN_MCP_COMMAND 未配置。")
        command, args = parts[0], parts[1:]
        resolved = shutil.which(command)
        if resolved is None:
            raise PublishError(
                "PUBLISH_MCP_NOT_INSTALLED",
                f"未找到 wenyan-mcp 可执行文件（{command}），请先 npm install -g @wenyan-md/mcp。",
            )
        return resolved, args

    def _subprocess_env(self) -> dict[str, str]:
        """Build the subprocess environment.

        Credentials are passed via env vars (wenyan-mcp reads
        WECHAT_APP_ID / WECHAT_APP_SECRET). When a data_dir is configured the
        wenyan-mcp config dir is redirected into it via XDG_CONFIG_HOME: on
        Windows the default is %APPDATA%\\wenyan-md, which may be unwritable
        for backend-spawned subprocesses under restricted tokens (EPERM on
        token.json). DATA_DIR is provably writable by this process
        (SQLite / assets / publish_tmp all live there).
        """
        env = {
            **os.environ,
            "WECHAT_APP_ID": self._settings.wechat_app_id,
            "WECHAT_APP_SECRET": self._settings.wechat_app_secret,
        }
        if self._data_dir is not None:
            env["XDG_CONFIG_HOME"] = str(self._data_dir)
        return env

    async def _call_tool(self, name: str, arguments: dict[str, Any]) -> list[str]:
        """Spawn the subprocess, run one tool call, and shut it down."""
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        command, args = self._server_command()
        params = StdioServerParameters(command=command, args=args, env=self._subprocess_env())

        async def run() -> list[str]:
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(name, arguments)
            texts: list[str] = []
            for item in result.content:
                text = getattr(item, "text", None)
                if text:
                    texts.append(text)
            return texts

        try:
            return await asyncio.wait_for(run(), timeout=self._timeout)
        except TimeoutError:
            raise PublishError(
                "PUBLISH_TIMEOUT",
                f"wenyan-mcp 调用超时（{self._timeout:.0f}s），请稍后重试。",
            ) from None
        except PublishError:
            raise
        except Exception as exc:  # subprocess spawn failures, protocol errors
            raise PublishError("PUBLISH_MCP_ERROR", f"wenyan-mcp 调用失败：{exc}") from exc

    async def list_themes(self) -> list[dict[str, str]]:
        """Return theme list; built-in themes first, custom themes after."""
        if self.fake_mode:
            return [dict(theme) for theme in FAKE_BUILTIN_THEMES]
        self._require_credentials()
        texts = await self._call_tool("list_themes", {})
        themes: list[dict[str, str]] = []
        for text in texts:
            if _TOOL_FAILURE_MARKER in text:
                raise PublishError("PUBLISH_MCP_ERROR", text)
            try:
                themes.append(json.loads(text))
            except json.JSONDecodeError:
                continue
        if not themes:
            raise PublishError(
                "PUBLISH_MCP_ERROR", "list_themes 未返回可解析的主题列表。"
            )
        return themes

    async def publish_article(self, markdown_path: str, theme_id: str) -> str:
        """Publish the markdown file with the given theme; return media_id."""
        if not theme_id or not theme_id.strip():
            raise PublishError("PUBLISH_THEME_MISSING", "发布主题（theme_id）不能为空。")
        if not os.path.isfile(markdown_path):
            raise PublishError(
                "PUBLISH_FILE_MISSING", f"待发布 Markdown 文件不存在：{markdown_path}"
            )
        self._require_credentials()
        if self.fake_mode:
            if FAKE_PUBLISH_FAILURE_MARKER in Path(markdown_path).read_text(
                encoding="utf-8"
            ):
                raise PublishError(
                    "PUBLISH_MCP_ERROR",
                    "fake 模式：正文包含「触发发布失败」，模拟公众号接口失败"
                    "（40164 invalid ip）。",
                )
            return f"FAKE_MEDIA_{uuid.uuid4().hex[:8]}"
        texts = await self._call_tool(
            "publish_article",
            {"file": os.path.abspath(markdown_path), "theme_id": theme_id.strip()},
        )
        text = "\n".join(texts)
        if _TOOL_FAILURE_MARKER in text:
            raise PublishError("PUBLISH_MCP_ERROR", text)
        media_id = extract_media_id(text)
        if media_id is None:
            raise PublishError(
                "PUBLISH_MCP_ERROR", f"无法从 wenyan-mcp 返回中解析 media_id：{text}"
            )
        return media_id
