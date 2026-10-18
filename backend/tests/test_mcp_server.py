from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest_asyncio
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.memory import create_connected_server_and_client_session

from app.main import create_app
from article_agent.config import Settings
from article_agent.image_providers import ImageProviderRegistry
from article_agent.models import (
    ArticleBrief,
    ImagePlanImage,
    ImagePlanResult,
    IntentDecision,
    UserIntent,
)
from article_agent.registry import (
    ModelCapabilities,
    ModelRegistry,
    conservative_token_estimate,
)

from .fakes import FakeChatModel, FakeImageProvider

ARTICLE_MARKDOWN = """# 专注的力量

第一段：专注是一种稀缺能力。

## 方法

第二段：把注意力收回到当下。
"""

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


def make_settings(
    data_dir: Path,
    *,
    mcp_enabled: bool = True,
    mcp_auth_token: str | None = None,
    mcp_allowed_hosts: str = "127.0.0.1,localhost,::1,test",
    mcp_wait_timeout_seconds: float = 180,
) -> Settings:
    return Settings(
        _env_file=None,
        default_llm_provider="deepseek",
        deepseek_api_key="test-mcp-key",
        deepseek_model="fake-model",
        deepseek_context_window=32_000,
        moonshot_api_key=None,
        moonshot_model=None,
        moonshot_context_window=None,
        default_image_provider=None,
        data_dir=data_dir,
        publish_fake_mode=True,
        wechat_app_id="fake-app-id",
        wechat_app_secret="fake-app-secret",
        mcp_enabled=mcp_enabled,
        mcp_auth_token=mcp_auth_token,
        mcp_allowed_hosts=mcp_allowed_hosts,
        mcp_wait_timeout_seconds=mcp_wait_timeout_seconds,
    )


def make_registry(fake: FakeChatModel) -> ModelRegistry:
    registry = ModelRegistry()
    registry.register(
        "deepseek",
        "fake-model",
        fake,
        ModelCapabilities(
            context_window=32_000,
            max_output_tokens=2_000,
            supports_streaming=True,
            supports_structured_output=True,
            token_estimator=conservative_token_estimate,
        ),
    )
    return registry


def build_app(tmp_path: Path, *, fake: FakeChatModel, settings: Settings, image_provider: FakeImageProvider):
    image_registry = ImageProviderRegistry()
    image_registry.register("fake", image_provider)
    return create_app(
        settings=settings,
        registry=make_registry(fake),
        image_registry_override=image_registry,
        data_dir=tmp_path,
    )


@pytest_asyncio.fixture
async def mcp_env(tmp_path):
    fake = FakeChatModel(decisions=[], responses=[])
    image_provider = FakeImageProvider(data_dir=tmp_path)
    application = build_app(
        tmp_path,
        fake=fake,
        settings=make_settings(tmp_path),
        image_provider=image_provider,
    )
    async with application.router.lifespan_context(application):
        yield application, fake, image_provider, tmp_path


@asynccontextmanager
async def memory_client(application):
    async with create_connected_server_and_client_session(
        application.state.mcp_bundle.server
    ) as session:
        yield session


def tool_payload(result: Any) -> dict[str, Any]:
    assert result.isError is False, result.content
    return json.loads(result.content[0].text)


def intent(value: UserIntent) -> IntentDecision:
    return IntentDecision(intent=value, brief=ArticleBrief(topic="专注"))


def fake_image_plan() -> ImagePlanResult:
    return ImagePlanResult(
        mood="宁静",
        style_summary="低饱和水彩，统一晨光",
        images=[
            ImagePlanImage(
                block_index=2,
                position_hint="首段之后",
                layout="landscape",
                layout_reason="开篇横图",
                prompt="水彩插画：清晨窗边的书桌，柔和晨光",
            )
        ],
    )


async def test_tool_registry_and_disabled_endpoint(tmp_path):
    fake = FakeChatModel(decisions=[], responses=[])
    application = build_app(
        tmp_path,
        fake=fake,
        settings=make_settings(tmp_path, mcp_enabled=False),
        image_provider=FakeImageProvider(data_dir=tmp_path),
    )
    async with application.router.lifespan_context(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            for path in ("/mcp", "/mcp/"):
                response = await client.post(path, json={"jsonrpc": "2.0"})
                assert response.status_code == 404, response.text
                assert response.json()["error"]["code"] == "MCP_DISABLED"


async def test_http_mount_lists_tools_fake_mode(mcp_env):
    application, _, _, _ = mcp_env
    transport = httpx.ASGITransport(app=application)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        for url in ("http://test/mcp", "http://test/mcp/"):
            async with streamable_http_client(url, http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    assert {tool.name for tool in tools.tools} == EXPECTED_TOOLS


async def test_http_mount_bearer_token_guard(tmp_path):
    fake = FakeChatModel(decisions=[], responses=[])
    application = build_app(
        tmp_path,
        fake=fake,
        settings=make_settings(tmp_path, mcp_auth_token="s3cret"),
        image_provider=FakeImageProvider(data_dir=tmp_path),
    )
    async with application.router.lifespan_context(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            unauthorized = await client.post(
                "/mcp/", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"}
            )
            assert unauthorized.status_code == 401
            assert unauthorized.json()["error"]["code"] == "MCP_UNAUTHORIZED"
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"Authorization": "Bearer s3cret"},
        ) as http:
            async with streamable_http_client("http://test/mcp/", http_client=http) as (
                read,
                write,
                _,
            ):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    assert len(tools.tools) == len(EXPECTED_TOOLS)


async def test_http_mount_host_allowlist(tmp_path):
    fake = FakeChatModel(decisions=[], responses=[])
    application = build_app(
        tmp_path,
        fake=fake,
        settings=make_settings(tmp_path, mcp_allowed_hosts="only.allowed.test"),
        image_provider=FakeImageProvider(data_dir=tmp_path),
    )
    async with application.router.lifespan_context(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post("/mcp/", json={"jsonrpc": "2.0"})
            assert response.status_code == 403
            assert response.json()["error"]["code"] == "MCP_HOST_FORBIDDEN"

            evil_origin = await client.post(
                "/mcp/",
                json={"jsonrpc": "2.0"},
                headers={
                    "Host": "only.allowed.test",
                    "Origin": "http://evil.example",
                },
            )
            assert evil_origin.status_code == 403
            assert evil_origin.json()["error"]["code"] == "MCP_ORIGIN_FORBIDDEN"


async def test_full_flow_via_memory_session(mcp_env, monkeypatch):
    application, fake, image_provider, tmp_path = mcp_env
    fake.chunk_delay = 0

    async def fake_render(markdown: str, theme_id: str) -> str:
        assert theme_id == "default"
        return f"<section>{markdown[:40]}</section>"

    monkeypatch.setattr(
        application.state.wenyan_client, "render_markdown", fake_render
    )

    async with memory_client(application) as session:
        status = tool_payload(await session.call_tool("studio_status", {}))
        assert status["llm"]["default_provider"] == "deepseek"
        assert status["wechat"]["configured"] is True
        assert status["image"]["providers"] == [
            {"provider": "fake", "model": "fake-image-model"}
        ]

        article = tool_payload(await session.call_tool("create_article", {}))
        article_id = article["id"]
        assert article["title"] == "未命名文章"

        fake.decisions.append(intent(UserIntent.GENERATE))
        fake.responses.append(ARTICLE_MARKDOWN)
        generated = tool_payload(
            await session.call_tool(
                "generate_article",
                {"article_id": article_id, "instruction": "写一篇关于专注的文章"},
            )
        )
        assert generated["title"] == "专注的力量"
        assert generated["content_markdown"].startswith("# 专注的力量")
        assert generated["article"]["current_version_id"] == generated["id"]

        image = tool_payload(
            await session.call_tool(
                "generate_image",
                {"prompt": "水彩：清晨窗边的书桌", "article_id": article_id},
            )
        )
        assert image["asset_id"]
        assert image["storage_url"].startswith("/static/assets/")
        assert image_provider.calls

        fake.decisions.append(fake_image_plan())
        plan = tool_payload(
            await session.call_tool(
                "plan_article_images", {"article_id": article_id}
            )
        )
        assert plan["plan"]["images"][0]["block_index"] == 2
        assert plan["session_id"]

        preview = tool_payload(
            await session.call_tool(
                "preview_publish",
                {
                    "article_id": article_id,
                    "image_placements": [
                        {"asset_id": image["asset_id"], "position": "after_block_2"}
                    ],
                    "cover_asset_id": image["asset_id"],
                    "author": "测试作者",
                },
            )
        )
        assert len(preview["blocks"]) == 4
        assert preview["blocks"][1]["preview"].startswith("第一段")
        assert "![](" in preview["markdown"]
        assert preview["markdown"].startswith("---")

        rendered = tool_payload(
            await session.call_tool(
                "render_publish_preview",
                {
                    "article_id": article_id,
                    "theme_id": "default",
                    "image_placements": [
                        {"asset_id": image["asset_id"], "position": "after_block_2"}
                    ],
                },
            )
        )
        assert rendered["html"].startswith("<section>")

        published = tool_payload(
            await session.call_tool(
                "publish_article",
                {
                    "article_id": article_id,
                    "theme_id": "default",
                    "image_placements": [
                        {"asset_id": image["asset_id"], "position": "after_block_2"}
                    ],
                    "cover_asset_id": image["asset_id"],
                    "author": "测试作者",
                },
            )
        )
        assert published["status"] == "succeeded"
        assert published["media_id"].startswith("FAKE_MEDIA_")
        assert published["draft_only"] is True
        assert published["wechat"]["app_id_masked"].startswith("fak***")

        records = tool_payload(
            await session.call_tool(
                "list_publish_records", {"article_id": article_id}
            )
        )
        assert records["items"][0]["status"] == "succeeded"

        asset_list = tool_payload(await session.call_tool("list_assets", {}))
        assert asset_list["items"][0]["id"] == image["asset_id"]

        article_detail = tool_payload(
            await session.call_tool("get_article", {"article_id": article_id})
        )
        assert article_detail["version_count"] == 1
        assert article_detail["current_version"]["title"] == "专注的力量"
        assert article_detail["versions"][0]["version_number"] == 1
        assert len(article_detail["versions"]) == 1


async def test_import_article_version_creates_versions(mcp_env):
    application, _, _, _ = mcp_env
    async with memory_client(application) as session:
        article = tool_payload(await session.call_tool("create_article", {}))
        article_id = article["id"]

        first = tool_payload(
            await session.call_tool(
                "import_article_version",
                {
                    "article_id": article_id,
                    "title": "智能体定稿 A",
                    "content_markdown": "# 智能体定稿 A\n\n第一版正文",
                },
            )
        )
        assert first["version_number"] == 1

        second = tool_payload(
            await session.call_tool(
                "import_article_version",
                {
                    "article_id": article_id,
                    "title": "智能体定稿 B",
                    "content_markdown": "# 智能体定稿 B\n\n第二版正文",
                    "instruction": "智能体直接写入",
                },
            )
        )
        assert second["version_number"] == 2
        assert second["article"]["current_version_id"] == second["id"]

        current = tool_payload(
            await session.call_tool(
                "get_article_version", {"article_id": article_id}
            )
        )
        assert current["title"] == "智能体定稿 B"
        assert current["content_markdown"].endswith("第二版正文")
        assert current["is_current"] is True

        older = tool_payload(
            await session.call_tool(
                "get_article_version",
                {"article_id": article_id, "version_id": first["id"]},
            )
        )
        assert older["is_current"] is False

        detail = tool_payload(
            await session.call_tool("get_article", {"article_id": article_id})
        )
        assert [item["version_number"] for item in detail["versions"]] == [2, 1]


async def test_generate_timeout_returns_running_then_wait(tmp_path):
    fake = FakeChatModel(decisions=[], responses=[], chunk_delay=0.05)
    application = build_app(
        tmp_path,
        fake=fake,
        settings=make_settings(tmp_path, mcp_wait_timeout_seconds=0.01),
        image_provider=FakeImageProvider(data_dir=tmp_path),
    )
    async with application.router.lifespan_context(application):
        async with memory_client(application) as session:
            article = tool_payload(await session.call_tool("create_article", {}))
            fake.decisions.append(intent(UserIntent.GENERATE))
            fake.responses.append(ARTICLE_MARKDOWN * 3)

            pending = tool_payload(
                await session.call_tool(
                    "generate_article",
                    {"article_id": article["id"], "instruction": "写一篇长文"},
                )
            )
            assert pending["status"] == "running"
            assert pending["run_id"]

            finished = tool_payload(
                await session.call_tool(
                    "wait_for_run",
                    {
                        "run_id": pending["run_id"],
                        "kind": "article",
                        "timeout_seconds": 30,
                    },
                )
            )
            assert finished["title"] == "专注的力量"
            assert finished["version_number"] == 1


async def test_tool_errors_are_structured(mcp_env):
    application, _, _, _ = mcp_env
    async with memory_client(application) as session:
        missing = await session.call_tool("get_article", {"article_id": "nope"})
        assert missing.isError is True
        assert "NOT_FOUND" in missing.content[0].text

        article = tool_payload(await session.call_tool("create_article", {}))
        empty_import = await session.call_tool(
            "import_article_version",
            {"article_id": article["id"], "title": "x", "content_markdown": "  "},
        )
        assert empty_import.isError is True
        assert "INVALID_ARGUMENT" in empty_import.content[0].text

        bad_placement = await session.call_tool(
            "preview_publish",
            {
                "article_id": article["id"],
                "image_placements": [{"asset_id": "a", "position": "middle"}],
            },
        )
        assert bad_placement.isError is True
        assert "INVALID_ARGUMENT" in bad_placement.content[0].text
