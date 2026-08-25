from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.wenyan_client import (
    FAKE_BUILTIN_THEMES,
    PublishError,
    WenyanMcpClient,
    extract_media_id,
)
from article_agent.config import Settings


def make_settings(**overrides) -> Settings:
    defaults = dict(
        _env_file=None,
        default_llm_provider="deepseek",
        deepseek_api_key="test-secret-key",
        deepseek_model="fake-model",
        deepseek_context_window=32_000,
        data_dir=Path("data"),
    )
    defaults.update(overrides)
    return Settings(**defaults)


def make_client(**overrides) -> WenyanMcpClient:
    return WenyanMcpClient(make_settings(**overrides))


async def test_real_mode_missing_credentials_fast_fail():
    client = make_client(publish_fake_mode=False)
    with pytest.raises(PublishError) as exc_info:
        await client.list_themes()
    assert exc_info.value.code == "PUBLISH_CREDENTIALS_MISSING"

    with pytest.raises(PublishError) as exc_info:
        await client.publish_article("whatever.md", "default")
    # Input checks (file exists) run first; missing file surfaces before credentials.
    assert exc_info.value.code == "PUBLISH_FILE_MISSING"


async def test_real_mode_missing_credentials_checked_before_subprocess(tmp_path):
    # Credentials present but command not installed: must fail with
    # PUBLISH_CREDENTIALS_MISSING for publish without touching the spawn path.
    client = make_client(
        publish_fake_mode=False,
        wechat_app_id="",
        wechat_app_secret="",
    )
    markdown = tmp_path / "article.md"
    markdown.write_text("---\ntitle: t\n---\n正文", encoding="utf-8")
    with pytest.raises(PublishError) as exc_info:
        await client.publish_article(str(markdown), "default")
    assert exc_info.value.code == "PUBLISH_CREDENTIALS_MISSING"


async def test_fake_list_themes_returns_builtin_themes():
    client = make_client(publish_fake_mode=True)
    themes = await client.list_themes()
    assert [theme["id"] for theme in themes] == [
        theme["id"] for theme in FAKE_BUILTIN_THEMES
    ]
    assert len(themes) == 8
    assert all(
        {"id", "name", "description"} <= set(theme.keys()) for theme in themes
    )


async def test_fake_publish_returns_fake_media_id(tmp_path):
    client = make_client(
        publish_fake_mode=True,
        wechat_app_id="fake-app-id",
        wechat_app_secret="fake-secret",
    )
    markdown = tmp_path / "article.md"
    markdown.write_text("---\ntitle: t\n---\n正文", encoding="utf-8")
    media_id = await client.publish_article(str(markdown), "orangeheart")
    assert media_id.startswith("FAKE_MEDIA_")
    assert len(media_id) == len("FAKE_MEDIA_") + 8


async def test_fake_publish_missing_file(tmp_path):
    client = make_client(
        publish_fake_mode=True,
        wechat_app_id="fake-app-id",
        wechat_app_secret="fake-secret",
    )
    with pytest.raises(PublishError) as exc_info:
        await client.publish_article(str(tmp_path / "nope.md"), "default")
    assert exc_info.value.code == "PUBLISH_FILE_MISSING"


async def test_fake_publish_empty_theme(tmp_path):
    client = make_client(
        publish_fake_mode=True,
        wechat_app_id="fake-app-id",
        wechat_app_secret="fake-secret",
    )
    markdown = tmp_path / "article.md"
    markdown.write_text("正文", encoding="utf-8")
    with pytest.raises(PublishError) as exc_info:
        await client.publish_article(str(markdown), " ")
    assert exc_info.value.code == "PUBLISH_THEME_MISSING"


async def test_fake_publish_missing_credentials(tmp_path):
    client = make_client(publish_fake_mode=True)
    markdown = tmp_path / "article.md"
    markdown.write_text("正文", encoding="utf-8")
    with pytest.raises(PublishError) as exc_info:
        await client.publish_article(str(markdown), "default")
    assert exc_info.value.code == "PUBLISH_CREDENTIALS_MISSING"


async def test_fake_publish_failure_marker_raises_mcp_error(tmp_path):
    # dev_fake_server 会在正文末尾嵌入「触发发布失败」标记，fake 模式据此模拟
    # 公众号接口失败，供 E2E / 手工冒烟验证失败记录与重试路径
    client = make_client(
        publish_fake_mode=True,
        wechat_app_id="fake-app-id",
        wechat_app_secret="fake-secret",
    )
    markdown = tmp_path / "article.md"
    markdown.write_text("---\ntitle: t\n---\n\n正文\n\n触发发布失败\n", encoding="utf-8")
    with pytest.raises(PublishError) as exc_info:
        await client.publish_article(str(markdown), "default")
    assert exc_info.value.code == "PUBLISH_MCP_ERROR"
    assert "40164" in exc_info.value.message


def test_extract_media_id_from_real_message_format():
    text = (
        "Your article was successfully published to '公众号草稿箱'. "
        "The media ID is AbCdEf1234567890==."
    )
    assert extract_media_id(text) == "AbCdEf1234567890=="


def test_extract_media_id_failure_text_returns_none():
    assert extract_media_id("执行工具失败: 40164 invalid ip") is None


def test_subprocess_env_includes_credentials_and_config_redirect(tmp_path):
    # data_dir given: wenyan-mcp config dir must be redirected into it via
    # XDG_CONFIG_HOME (avoids EPERM on %APPDATA%\wenyan-md under restricted
    # tokens), and credentials must be passed through.
    client = WenyanMcpClient(
        make_settings(
            publish_fake_mode=False,
            wechat_app_id="wx-test-id",
            wechat_app_secret="test-secret",
        ),
        data_dir=tmp_path,
    )
    env = client._subprocess_env()
    assert env["WECHAT_APP_ID"] == "wx-test-id"
    assert env["WECHAT_APP_SECRET"] == "test-secret"
    assert env["XDG_CONFIG_HOME"] == str(tmp_path)


def test_subprocess_env_without_data_dir_has_no_redirect():
    # No data_dir: keep the inherited environment untouched (no override).
    client = WenyanMcpClient(
        make_settings(
            publish_fake_mode=False,
            wechat_app_id="wx-test-id",
            wechat_app_secret="test-secret",
        )
    )
    env = client._subprocess_env()
    assert env["WECHAT_APP_ID"] == "wx-test-id"
    if "XDG_CONFIG_HOME" not in os.environ:
        assert "XDG_CONFIG_HOME" not in env


# ------------------------------------------------------------ render_markdown


async def test_render_markdown_empty_theme_rejected():
    client = make_client(publish_fake_mode=True)
    with pytest.raises(PublishError) as exc_info:
        await client.render_markdown("# t\n正文", " ")
    assert exc_info.value.code == "PUBLISH_THEME_MISSING"


async def test_render_markdown_empty_markdown_rejected():
    client = make_client(publish_fake_mode=True)
    with pytest.raises(PublishError) as exc_info:
        await client.render_markdown("   \n", "default")
    assert exc_info.value.code == "PUBLISH_RENDER_ERROR"


async def test_render_markdown_mcp_not_installed(tmp_path):
    # Command resolves to nothing on PATH → core cannot be located
    settings = make_settings(publish_fake_mode=True, data_dir=tmp_path)
    settings.wenyan_mcp_command = "wenyan-mcp-not-installed-xyz"
    client = WenyanMcpClient(settings)
    with pytest.raises(PublishError) as exc_info:
        await client.render_markdown("# t\n正文", "default")
    assert exc_info.value.code == "PUBLISH_MCP_NOT_INSTALLED"
    assert "npm install -g @wenyan-md/mcp" in exc_info.value.message


def _core_wrapper_available(client: WenyanMcpClient) -> bool:
    try:
        client._resolve_core_wrapper_path()
        return True
    except PublishError:
        return False


async def test_render_markdown_real_node_integration():
    """Real render via local node + @wenyan-md/core (skipped when not installed).

    Verifies preview HTML matches the publish rendering output shape:
    a <section id="wenyan"> with inline theme styles, and that unknown
    themes fail with the original core error message.
    """
    client = make_client(publish_fake_mode=True)
    if not _core_wrapper_available(client):
        pytest.skip("wenyan-mcp / @wenyan-md/core not installed locally")

    html = await client.render_markdown("---\ntitle: t\n---\n\n## 标题\n\n正文", "default")
    assert html.startswith('<section id="wenyan"')
    assert "标题" in html
    assert "正文" in html

    with pytest.raises(PublishError) as exc_info:
        await client.render_markdown("# t", "no-such-theme-xyz")
    assert exc_info.value.code == "PUBLISH_RENDER_ERROR"
    assert "no-such-theme-xyz" in exc_info.value.message
