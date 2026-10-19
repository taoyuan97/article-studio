from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from app.main import create_app
from app.settings_store import SettingsStore
from article_agent.config import Settings
from article_agent.registry import ModelCapabilities, ModelRegistry, conservative_token_estimate

from .fakes import FakeChatModel


def make_settings(data_dir: Path, **overrides) -> Settings:
    values = dict(
        _env_file=None,
        default_llm_provider="deepseek",
        default_image_provider=None,
        deepseek_api_key="env-deepseek-secret",
        deepseek_model="fake-model",
        deepseek_context_window=32_000,
        moonshot_api_key=None,
        moonshot_model=None,
        moonshot_context_window=None,
        data_dir=data_dir,
    )
    values.update(overrides)
    return Settings(**values)


def make_registry() -> ModelRegistry:
    registry = ModelRegistry()
    registry.register(
        "deepseek",
        "fake-model",
        FakeChatModel(decisions=[], responses=[]),
        ModelCapabilities(
            context_window=32_000,
            max_output_tokens=2_000,
            supports_streaming=True,
            supports_structured_output=True,
            token_estimator=conservative_token_estimate,
        ),
    )
    return registry


@pytest_asyncio.fixture
async def settings_api(tmp_path):
    application = create_app(
        settings=make_settings(tmp_path),
        registry=make_registry(),
        data_dir=tmp_path,
    )
    async with application.router.lifespan_context(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield application, client, tmp_path


@pytest_asyncio.fixture
async def mcp_api(tmp_path):
    application = create_app(
        settings=make_settings(
            tmp_path,
            mcp_allowed_hosts="127.0.0.1,localhost,::1,test",
        ),
        registry=make_registry(),
        data_dir=tmp_path,
    )
    async with application.router.lifespan_context(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield application, client, tmp_path


def test_blank_mcp_token_is_normalised_to_disabled(tmp_path):
    settings = make_settings(tmp_path, mcp_enabled=True, mcp_auth_token="")
    assert settings.mcp_auth_token is None
    assert settings.mcp_auth_enabled is False


def test_mcp_auth_enabled_requires_token(tmp_path):
    with pytest.raises(ValueError, match="MCP_AUTH_TOKEN"):
        make_settings(tmp_path, mcp_auth_enabled=True, mcp_auth_token="  ")


def test_store_persists_field_overrides_and_reloads(tmp_path):
    path = tmp_path / "settings.json"
    store = SettingsStore(make_settings(tmp_path), path)
    candidate, prepared = store.prepare(
        {"deepseek_model": "deepseek-chat", "llm_max_retries": 4},
        expected_revision=0,
    )
    assert prepared.deepseek_model == "deepseek-chat"
    store.commit(candidate, expected_revision=0)

    reloaded = SettingsStore(make_settings(tmp_path), path)
    assert reloaded.revision == 1
    assert reloaded.current.deepseek_model == "deepseek-chat"
    assert reloaded.current.llm_max_retries == 4
    assert json.loads(path.read_text(encoding="utf-8"))["overrides"]["deepseek_model"] == "deepseek-chat"


async def test_status_masks_env_secret_and_runtime_update_persists(settings_api):
    _application, client, tmp_path = settings_api
    status = await client.get("/api/settings/status")
    assert status.status_code == 200
    body = status.json()
    assert body["revision"] == 0
    assert body["providers"]["llm_deepseek"]["credential_source"] == "env"
    assert body["providers"]["llm_deepseek"]["credential_masked"] != "env-deepseek-secret"
    assert "env-deepseek-secret" not in status.text
    assert body["providers"]["image_dreamina"]["editable"] is False

    updated = await client.patch(
        "/api/settings/runtime",
        json={"revision": 0, "llm_max_retries": 3},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["revision"] == 1
    assert updated.json()["runtime"]["llm_max_retries"] == 3
    assert (tmp_path / "settings.json").is_file()


async def test_wechat_runtime_reveal_and_clear(settings_api):
    _application, client, _tmp_path = settings_api
    saved = await client.patch(
        "/api/settings/wechat",
        json={"revision": 0, "app_id": "wx-runtime", "app_secret": "wechat-secret"},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["wechat"]["credential_source"] == "runtime"
    assert "wechat-secret" not in saved.text

    revealed = await client.post(
        "/api/settings/wechat/credentials/reveal",
        json={"revision": 1, "field": "app_secret"},
    )
    assert revealed.status_code == 200
    assert revealed.json()["value"] == "wechat-secret"
    assert revealed.headers["cache-control"] == "no-store"

    cleared = await client.request(
        "DELETE", "/api/settings/wechat/credentials", json={"revision": 1}
    )
    assert cleared.status_code == 200
    assert cleared.json()["wechat"]["configured"] is False


async def test_model_mutation_rejected_while_run_active(settings_api):
    application, client, _tmp_path = settings_api
    application.state.manager._active_by_article["article"] = "run"
    response = await client.patch(
        "/api/settings/runtime",
        json={"revision": 0, "llm_max_retries": 3},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "SETTINGS_RUN_ACTIVE"
    assert application.state.settings_store.revision == 0


async def test_settings_mutation_rejects_untrusted_origin(settings_api):
    _application, client, _tmp_path = settings_api
    response = await client.patch(
        "/api/settings/runtime",
        headers={"Origin": "https://evil.example"},
        json={"revision": 0, "llm_max_retries": 3},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "SETTINGS_ORIGIN_FORBIDDEN"


_MCP_INIT_PAYLOAD = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "settings-test", "version": "0"},
    },
}
_MCP_ACCEPT = {"Accept": "application/json, text/event-stream"}


async def test_mcp_status_defaults(mcp_api):
    _application, client, _tmp_path = mcp_api
    body = (await client.get("/api/settings/status")).json()
    mcp = body["mcp"]
    assert mcp["enabled"] is False
    assert mcp["transport"] == "streamable-http"
    assert mcp["tool_count"] == 16
    assert mcp["endpoint"] == "http://test/mcp/"
    assert mcp["auth"]["enabled"] is False
    assert mcp["auth"]["token_masked"] is None
    assert mcp["allowed_hosts"] == ["127.0.0.1", "localhost", "::1", "test"]
    assert mcp["wait_timeout_seconds"] == 180


async def test_mcp_update_hot_applies_and_masks_token(mcp_api):
    _application, client, tmp_path = mcp_api
    saved = await client.patch(
        "/api/settings/mcp",
        json={
            "revision": 0,
            "enabled": True,
            "auth_enabled": True,
            "auth_token": "mcp-secret",
            "allowed_hosts": ["127.0.0.1", "localhost", "::1", "test"],
            "wait_timeout_seconds": 120,
        },
    )
    assert saved.status_code == 200, saved.text
    mcp = saved.json()["mcp"]
    assert mcp["enabled"] is True
    assert mcp["auth"]["enabled"] is True
    assert mcp["auth"]["token_masked"] == "mcp***cret"
    assert "mcp-secret" not in saved.text
    assert mcp["auth"]["token_source"] == "runtime"
    assert mcp["auth"]["runtime_token"] is True
    assert mcp["enabled_source"] == "runtime"
    assert mcp["wait_timeout_seconds"] == 120
    assert (tmp_path / "settings.json").is_file()

    no_auth = await client.post("/mcp/", json=_MCP_INIT_PAYLOAD, headers=_MCP_ACCEPT)
    assert no_auth.status_code == 401
    unauthorized = no_auth
    assert unauthorized.headers["www-authenticate"] == "Bearer"

    with_auth = await client.post(
        "/mcp/",
        json=_MCP_INIT_PAYLOAD,
        headers={**_MCP_ACCEPT, "Authorization": "Bearer mcp-secret"},
    )
    assert with_auth.status_code == 200, with_auth.text

    disabled = await client.patch(
        "/api/settings/mcp",
        json={"revision": 1, "auth_enabled": False},
    )
    assert disabled.status_code == 200
    no_header = await client.post("/mcp/", json=_MCP_INIT_PAYLOAD, headers=_MCP_ACCEPT)
    assert no_header.status_code == 200
    assert disabled.json()["mcp"]["auth"]["enabled"] is False


async def test_mcp_token_reveal_clear_and_revision_conflict(mcp_api):
    _application, client, _tmp_path = mcp_api
    saved = await client.patch(
        "/api/settings/mcp",
        json={"revision": 0, "enabled": True, "auth_enabled": True, "auth_token": "reveal-me"},
    )
    assert saved.status_code == 200
    revealed = await client.post(
        "/api/settings/mcp/token/reveal",
        json={"revision": 1, "field": "auth_token"},
    )
    assert revealed.status_code == 200
    assert revealed.json()["value"] == "reveal-me"
    assert revealed.headers["cache-control"] == "no-store"

    conflict = await client.patch(
        "/api/settings/mcp",
        json={"revision": 0, "enabled": False},
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "SETTINGS_REVISION_CONFLICT"

    disabled = await client.patch(
        "/api/settings/mcp",
        json={"revision": 1, "auth_enabled": False},
    )
    assert disabled.status_code == 200
    cleared = await client.request(
        "DELETE", "/api/settings/mcp/token", json={"revision": 2}
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["mcp"]["auth"]["token_masked"] is None
    assert cleared.json()["mcp"]["auth"]["token_source"] is None


async def test_mcp_validation_rejects_blank_token_and_bad_hosts(mcp_api):
    _application, client, _tmp_path = mcp_api
    blank = await client.patch(
        "/api/settings/mcp",
        json={"revision": 0, "auth_token": "   "},
    )
    assert blank.status_code == 422
    assert blank.json()["error"]["code"] == "SETTINGS_PARAMS_INVALID"

    bad_host = await client.patch(
        "/api/settings/mcp",
        json={"revision": 0, "allowed_hosts": ["http://evil.example"]},
    )
    assert bad_host.status_code == 422

    empty_hosts = await client.patch(
        "/api/settings/mcp",
        json={"revision": 0, "allowed_hosts": []},
    )
    assert empty_hosts.status_code == 422

    enabled_without_token = await client.patch(
        "/api/settings/mcp",
        json={"revision": 0, "auth_enabled": True},
    )
    assert enabled_without_token.status_code == 422


async def test_mcp_token_only_enables_auth(mcp_api):
    _application, client, _tmp_path = mcp_api
    saved = await client.patch(
        "/api/settings/mcp",
        json={"revision": 0, "enabled": True, "auth_token": "only-token"},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["mcp"]["auth"]["enabled"] is True
    no_auth = await client.post("/mcp/", json=_MCP_INIT_PAYLOAD, headers=_MCP_ACCEPT)
    assert no_auth.status_code == 401


async def test_mcp_save_allowed_while_run_active(mcp_api):
    application, client, _tmp_path = mcp_api
    application.state.manager._active_by_article["article"] = "run"
    response = await client.patch(
        "/api/settings/mcp",
        json={"revision": 0, "enabled": True},
    )
    assert response.status_code == 200
    assert response.json()["mcp"]["enabled"] is True


async def test_mcp_probe_is_config_level(mcp_api):
    _application, client, _tmp_path = mcp_api
    disabled = await client.post("/api/settings/probe/mcp")
    assert disabled.status_code == 200
    assert disabled.json()["ok"] is False
    assert "未开启" in disabled.json()["message"]

    await client.patch(
        "/api/settings/mcp", json={"revision": 0, "enabled": True}
    )
    enabled = await client.post("/api/settings/probe/mcp")
    assert enabled.status_code == 200
    assert enabled.json()["ok"] is True
    assert "16" in enabled.json()["message"]


async def test_enabled_mcp_with_blank_token_allows_initialize(tmp_path):
    application = create_app(
        settings=make_settings(
            tmp_path,
            mcp_enabled=True,
            mcp_auth_token="",
            mcp_allowed_hosts="127.0.0.1,localhost,::1,test",
        ),
        registry=make_registry(),
        data_dir=tmp_path,
    )
    async with application.router.lifespan_context(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            status = await client.get("/api/settings/status")
            mcp = status.json()["mcp"]
            assert mcp["enabled"] is True
            assert mcp["auth"]["enabled"] is False
            assert mcp["auth"]["token_masked"] is None
            response = await client.post(
                "/mcp/", json=_MCP_INIT_PAYLOAD, headers=_MCP_ACCEPT
            )
            assert response.status_code == 200
