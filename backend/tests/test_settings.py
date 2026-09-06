from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest_asyncio

from app.main import create_app
from app.settings_store import SettingsStore
from article_agent.config import Settings
from article_agent.registry import ModelCapabilities, ModelRegistry, conservative_token_estimate

from .fakes import FakeChatModel


def make_settings(data_dir: Path) -> Settings:
    return Settings(
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
