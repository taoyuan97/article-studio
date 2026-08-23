from __future__ import annotations

import pytest_asyncio

from app.main import create_app
from article_agent.config import Settings
from article_agent.image_providers import ImageProviderRegistry
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
        from httpx import ASGITransport, AsyncClient
        async with AsyncClient(transport=ASGITransport(app=application), base_url="http://test") as client:
            yield application, client, tmp_path


async def test_save_asset_success(api):
    _, client, _ = api
    session_response = await client.post("/api/image-sessions", json={})
    session_id = session_response.json()["id"]

    run_response = await client.post(
        f"/api/image-sessions/{session_id}/messages",
        json={"content": "生成一张红色封面图", "provider": "fake", "model": "fake-image-model"},
    )
    run_id = run_response.json()["run_id"]

    # Drain events to complete the run.
    application, _, _ = api
    async for _event in application.state.image_manager.events(run_id):
        pass

    workspace = await client.get(f"/api/image-sessions/{session_id}/workspace")
    assistant_message = [m for m in workspace.json()["messages"] if m["role"] == "assistant"][0]

    response = await client.post("/api/assets", json={
        "source_session_id": session_id,
        "source_message_id": assistant_message["id"],
        "title": "红色封面图",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["kind"] == "image"
    assert data["source"] == "image_generation"
    assert data["title"] == "红色封面图"
    assert data["storage_url"]
    assert data["metadata"]["image_prompt"]


async def test_save_asset_message_not_found(api):
    _, client, _ = api
    session_response = await client.post("/api/image-sessions", json={})
    session_id = session_response.json()["id"]

    response = await client.post("/api/assets", json={
        "source_session_id": session_id,
        "source_message_id": "not-exist",
        "title": "素材",
    })
    assert response.status_code == 404


async def test_save_asset_no_image_url(api):
    _, client, _ = api
    session_response = await client.post("/api/image-sessions", json={})
    session_id = session_response.json()["id"]

    # Create a user message without generating an image.
    run_response = await client.post(
        f"/api/image-sessions/{session_id}/messages",
        json={"content": "生成一张红色封面图", "provider": "fake", "model": "fake-image-model"},
    )
    run_id = run_response.json()["run_id"]
    application, _, _ = api
    async for _event in application.state.image_manager.events(run_id):
        pass

    workspace = await client.get(f"/api/image-sessions/{session_id}/workspace")
    user_message = [m for m in workspace.json()["messages"] if m["role"] == "user"][0]

    response = await client.post("/api/assets", json={
        "source_session_id": session_id,
        "source_message_id": user_message["id"],
        "title": "素材",
    })
    assert response.status_code == 422


async def test_save_asset_idempotent(api):
    _, client, _ = api
    session_response = await client.post("/api/image-sessions", json={})
    session_id = session_response.json()["id"]

    run_response = await client.post(
        f"/api/image-sessions/{session_id}/messages",
        json={"content": "生成一张红色封面图", "provider": "fake", "model": "fake-image-model"},
    )
    run_id = run_response.json()["run_id"]
    application, _, _ = api
    async for _event in application.state.image_manager.events(run_id):
        pass

    workspace = await client.get(f"/api/image-sessions/{session_id}/workspace")
    assistant_message = [m for m in workspace.json()["messages"] if m["role"] == "assistant"][0]

    first = await client.post("/api/assets", json={
        "source_session_id": session_id,
        "source_message_id": assistant_message["id"],
        "title": "第一次",
    })
    second = await client.post("/api/assets", json={
        "source_session_id": session_id,
        "source_message_id": assistant_message["id"],
        "title": "第二次",
    })
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]


async def test_list_assets_default_image(api):
    _, client, _ = api
    session_response = await client.post("/api/image-sessions", json={})
    session_id = session_response.json()["id"]

    run_response = await client.post(
        f"/api/image-sessions/{session_id}/messages",
        json={"content": "生成一张红色封面图", "provider": "fake", "model": "fake-image-model"},
    )
    run_id = run_response.json()["run_id"]
    application, _, _ = api
    async for _event in application.state.image_manager.events(run_id):
        pass

    workspace = await client.get(f"/api/image-sessions/{session_id}/workspace")
    assistant_message = [m for m in workspace.json()["messages"] if m["role"] == "assistant"][0]

    await client.post("/api/assets", json={
        "source_session_id": session_id,
        "source_message_id": assistant_message["id"],
        "title": "封面图",
    })

    response = await client.get("/api/assets")
    assert response.status_code == 200
    data = response.json()
    assert len(data["items"]) == 1
    assert data["items"][0]["kind"] == "image"
    assert data["items"][0]["title"] == "封面图"


async def test_get_asset(api):
    _, client, _ = api
    session_response = await client.post("/api/image-sessions", json={})
    session_id = session_response.json()["id"]

    run_response = await client.post(
        f"/api/image-sessions/{session_id}/messages",
        json={"content": "生成一张红色封面图", "provider": "fake", "model": "fake-image-model"},
    )
    run_id = run_response.json()["run_id"]
    application, _, _ = api
    async for _event in application.state.image_manager.events(run_id):
        pass

    workspace = await client.get(f"/api/image-sessions/{session_id}/workspace")
    assistant_message = [m for m in workspace.json()["messages"] if m["role"] == "assistant"][0]

    saved = await client.post("/api/assets", json={
        "source_session_id": session_id,
        "source_message_id": assistant_message["id"],
        "title": "封面图",
    })
    asset_id = saved.json()["id"]

    response = await client.get(f"/api/assets/{asset_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == asset_id
    assert data["kind"] == "image"
    assert data["storage_url"]
