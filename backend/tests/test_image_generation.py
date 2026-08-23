from __future__ import annotations

import httpx
import pytest
import pytest_asyncio

from app.main import create_app
from article_agent.config import Settings
from article_agent.image_providers import (
    ImageProviderRegistry,
    resolve_image_size,
)
from article_agent.registry import (
    ModelCapabilities,
    ModelRegistry,
    conservative_token_estimate,
)

from .fakes import FakeChatModel, FakeImageProvider


def make_settings(data_dir) -> Settings:
    return Settings(
        _env_file=None,
        default_llm_provider="deepseek",
        deepseek_api_key="test-secret-key",
        deepseek_model="fake-model",
        deepseek_context_window=32_000,
        moonshot_api_key=None,
        moonshot_model=None,
        moonshot_context_window=None,
        data_dir=data_dir,
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


def make_image_registry(data_dir) -> ImageProviderRegistry:
    registry = ImageProviderRegistry()
    registry.register("fake", FakeImageProvider(data_dir=data_dir))
    return registry


@pytest_asyncio.fixture
async def api(tmp_path):
    fake = FakeChatModel(decisions=[], responses=[], chunk_delay=0)
    application = create_app(
        settings=make_settings(tmp_path),
        registry=make_registry(fake),
        image_registry_override=make_image_registry(tmp_path),
        data_dir=tmp_path,
    )
    async with application.router.lifespan_context(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            yield application, client, tmp_path


async def test_create_image_session(api):
    _, client, _ = api
    response = await client.post("/api/image-sessions", json={})
    assert response.status_code == 200
    data = response.json()
    assert data["id"]
    assert data["title"] == "未命名配图"
    assert data["provider"] == "fake"
    assert data["model"] == "fake-image-model"
    assert data["status"] == "idle"


async def test_create_image_session_with_article_id(api):
    _, client, _ = api
    article_response = await client.post("/api/articles")
    article_id = article_response.json()["id"]

    response = await client.post(
        "/api/image-sessions", json={"article_id": article_id}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["article_id"] == article_id


async def test_create_image_session_with_invalid_article_id(api):
    _, client, _ = api
    response = await client.post(
        "/api/image-sessions", json={"article_id": "not-exist"}
    )
    assert response.status_code == 404


async def test_generate_image_through_message(api):
    application, client, _ = api
    session_response = await client.post("/api/image-sessions", json={})
    session_id = session_response.json()["id"]

    response = await client.post(
        f"/api/image-sessions/{session_id}/messages",
        json={"content": "生成一张红色封面图", "provider": "fake", "model": "fake-image-model"},
    )
    assert response.status_code == 202, response.text
    run = response.json()
    assert run["run_id"]
    assert run["session_id"] == session_id
    assert run["status"] in ("queued", "running", "completed")

    events = [
        event
        async for event in application.state.image_manager.events(run["run_id"])
    ]
    event_types = [event.type for event in events]
    assert "run.started" in event_types
    assert "image.completed" in event_types
    assert "run.completed" in event_types

    workspace = await client.get(f"/api/image-sessions/{session_id}/workspace")
    assert workspace.status_code == 200
    messages = workspace.json()["messages"]
    assert len(messages) == 2
    assert messages[0]["role"] == "user"
    assert messages[1]["role"] == "assistant"
    assert messages[1]["image_url"]


async def test_generate_image_with_size_params(api):
    application, client, tmp_path = api
    session_response = await client.post("/api/image-sessions", json={})
    session_id = session_response.json()["id"]

    response = await client.post(
        f"/api/image-sessions/{session_id}/messages",
        json={
            "content": "生成一张红色封面图",
            "provider": "fake",
            "model": "fake-image-model",
            "tier": "2K",
            "ratio": "16:9",
        },
    )
    assert response.status_code == 202, response.text
    run_id = response.json()["run_id"]

    events = [
        event
        async for event in application.state.image_manager.events(run_id)
    ]
    event_types = [event.type for event in events]
    assert "run.started" in event_types
    assert "image.completed" in event_types
    assert "run.completed" in event_types

    fake_provider = application.state.image_registry.get("fake")
    assert len(fake_provider.calls) == 1
    _prompt, kwargs = fake_provider.calls[0]
    assert kwargs.get("size") == "2048*1152"

    workspace = await client.get(f"/api/image-sessions/{session_id}/workspace")
    assert workspace.status_code == 200
    runs = workspace.json().get("session", {}).get("runs", [])
    # The workspace endpoint currently does not return runs; verify via repository.
    repository = application.state.repository
    run = repository.get_image_run(run_id)
    assert run["size"] == "2048*1152"
    assert run["tier"] == "2K"
    assert run["ratio"] == "16:9"


async def test_resolve_image_size():
    assert resolve_image_size("aliyun_wanxiang", "2K", "16:9") == "2048*1152"
    assert resolve_image_size("aliyun_wanxiang", "4K", "1:1") == "4096*4096"
    assert resolve_image_size("dreamina", "2K", "16:9") == "2048x1152"
    assert resolve_image_size("dreamina", "3K", "1:1") == "3072x3072"

    with pytest.raises(ValueError):
        resolve_image_size("aliyun_wanxiang", "4K", "21:9")

    with pytest.raises(ValueError):
        resolve_image_size("unknown", "2K", "1:1")


async def test_active_run_blocks_second_message(api):
    application, client, _ = api
    session_response = await client.post("/api/image-sessions", json={})
    session_id = session_response.json()["id"]

    first = await client.post(
        f"/api/image-sessions/{session_id}/messages",
        json={"content": "first", "provider": "fake", "model": "fake-image-model"},
    )
    assert first.status_code == 202

    second = await client.post(
        f"/api/image-sessions/{session_id}/messages",
        json={"content": "second", "provider": "fake", "model": "fake-image-model"},
    )
    assert second.status_code == 409

    # Drain the first run so lifespan shutdown is clean.
    async for _event in application.state.image_manager.events(first.json()["run_id"]):
        pass


async def test_cancel_image_run(api):
    application, client, _ = api
    session_response = await client.post("/api/image-sessions", json={})
    session_id = session_response.json()["id"]

    run_response = await client.post(
        f"/api/image-sessions/{session_id}/messages",
        json={"content": "slow", "provider": "fake", "model": "fake-image-model"},
    )
    run_id = run_response.json()["run_id"]

    cancel_response = await client.post(f"/api/image-runs/{run_id}/cancel")
    assert cancel_response.status_code == 200
    data = cancel_response.json()
    assert data["cancelled"] is True

    events = [
        event
        async for event in application.state.image_manager.events(run_id)
    ]
    event_types = [event.type for event in events]
    assert "run.cancelled" in event_types
    assert "run.completed" in event_types
