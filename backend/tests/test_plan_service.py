from __future__ import annotations

from pathlib import Path

import httpx
import pytest_asyncio

from app.main import create_app
from app.plan_service import _sanitize_images
from article_agent.config import Settings
from article_agent.image_providers import ImageProviderRegistry
from article_agent.models import (
    ArticleBrief,
    ImagePlanImage,
    ImagePlanResult,
    IntentDecision,
    UserIntent,
)
from article_agent.prompts import (
    DEFAULT_IMAGE_PLAN_INSTRUCTIONS,
    DEFAULT_IMAGE_PLAN_ROLE,
)
from article_agent.registry import (
    ModelCapabilities,
    ModelRegistry,
    conservative_token_estimate,
)

from .fakes import FakeChatModel, FakeImageProvider


def make_settings(data_dir: Path) -> Settings:
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


@pytest_asyncio.fixture
async def api(tmp_path):
    fake = FakeChatModel(decisions=[], responses=[], chunk_delay=0)
    image_registry = ImageProviderRegistry()
    image_registry.register("fake", FakeImageProvider(data_dir=tmp_path))
    application = create_app(
        settings=make_settings(tmp_path),
        registry=make_registry(fake),
        image_registry_override=image_registry,
        data_dir=tmp_path,
    )
    async with application.router.lifespan_context(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            yield application, client, fake, tmp_path


def plan_result(*, block_indices: list[int]) -> ImagePlanResult:
    return ImagePlanResult(
        mood="温暖治愈",
        style_summary="暖色调水彩插画",
        images=[
            ImagePlanImage(
                block_index=index,
                position_hint=f"第 {index} 块之后",
                layout="landscape",
                layout_reason="横版大图",
                prompt=f"提示词 {index}",
            )
            for index in block_indices
        ],
    )


async def create_article_with_version(api) -> tuple[dict, dict]:
    """通过 fake 文章线生成 v1 版本，返回 (article, workspace)。"""
    application, client, fake, _ = api
    article = (await client.post("/api/articles")).json()
    fake.decisions.append(
        IntentDecision(intent=UserIntent.GENERATE, brief=ArticleBrief(topic="测试"))
    )
    fake.responses.append("# 测试文章\n\n第一段正文。\n\n第二段正文。")
    run = (
        await client.post(
            f"/api/articles/{article['id']}/messages", json={"content": "写一篇测试文章"}
        )
    ).json()
    [event async for event in application.state.manager.events(run["run_id"])]
    workspace = (
        await client.get(f"/api/articles/{article['id']}/workspace")
    ).json()
    return article, workspace


async def create_session(client: httpx.AsyncClient, article_id: str | None = None):
    payload = {"article_id": article_id} if article_id else {}
    response = await client.post("/api/image-sessions", json=payload)
    assert response.status_code == 200
    return response.json()


# ---------- 服务层：block_index clamp 与去重 ----------


def test_sanitize_images_clamps_and_dedupes():
    images = plan_result(block_indices=[0, 2, 2, 99]).images
    sanitized = _sanitize_images(images, block_count=5)
    assert [image.block_index for image in sanitized] == [1, 2, 5]


def test_sanitize_images_keeps_order_and_first_occurrence():
    images = plan_result(block_indices=[3, 1, 3, 1]).images
    sanitized = _sanitize_images(images, block_count=10)
    assert [image.block_index for image in sanitized] == [3, 1]


def test_sanitize_images_single_block():
    images = plan_result(block_indices=[2, 7]).images
    sanitized = _sanitize_images(images, block_count=1)
    assert [image.block_index for image in sanitized] == [1]


# ---------- 接口契约 ----------


async def test_image_plan_defaults(api):
    _, client, _, _ = api
    response = await client.get("/api/image-plan/defaults")
    assert response.status_code == 200
    data = response.json()
    assert data["role"] == DEFAULT_IMAGE_PLAN_ROLE
    assert data["instructions"] == DEFAULT_IMAGE_PLAN_INSTRUCTIONS
    assert data["models"] == [
        {"provider": "deepseek", "model": "fake-model", "context_window": 32_000}
    ]
    assert data["default_model"] == {
        "provider": "deepseek",
        "model": "fake-model",
        "context_window": 32_000,
    }


async def test_create_and_get_image_plan(api):
    _, client, fake, _ = api
    article, workspace = await create_article_with_version(api)
    session = await create_session(client, article["id"])
    fake.decisions.append(plan_result(block_indices=[1, 2, 3]))

    response = await client.post(
        f"/api/image-sessions/{session['id']}/image-plan",
        json={
            "article_id": article["id"],
            "provider": "deepseek",
            "model": "fake-model",
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["article_id"] == article["id"]
    assert payload["version_id"] == workspace["current_version"]["id"]
    assert payload["article_title"] == "测试文章"
    assert payload["word_count"] > 0
    assert payload["block_count"] >= 2
    assert [image["block_index"] for image in payload["plan"]["images"]] == [1, 2, 3]
    assert payload["plan"]["mood"] == "温暖治愈"
    # role / instructions 为空时回填默认值
    assert payload["role"] == DEFAULT_IMAGE_PLAN_ROLE
    assert payload["instructions"] == DEFAULT_IMAGE_PLAN_INSTRUCTIONS

    # GET 恢复最近一条方案
    fetched = (
        await client.get(f"/api/image-sessions/{session['id']}/image-plan")
    ).json()
    assert fetched == payload


async def test_create_image_plan_overwrites_previous(api):
    _, client, fake, _ = api
    article, _ = await create_article_with_version(api)
    session = await create_session(client, article["id"])

    fake.decisions.append(plan_result(block_indices=[1, 2, 3]))
    first = await client.post(
        f"/api/image-sessions/{session['id']}/image-plan",
        json={
            "article_id": article["id"],
            "provider": "deepseek",
            "model": "fake-model",
        },
    )
    assert first.status_code == 200

    fake.decisions.append(plan_result(block_indices=[2]))
    second = await client.post(
        f"/api/image-sessions/{session['id']}/image-plan",
        json={
            "article_id": article["id"],
            "provider": "deepseek",
            "model": "fake-model",
            "role": "自定义角色",
            "instructions": "自定义指令",
        },
    )
    assert second.status_code == 200
    payload = second.json()
    assert payload["role"] == "自定义角色"
    assert payload["instructions"] == "自定义指令"
    assert [image["block_index"] for image in payload["plan"]["images"]] == [2]

    fetched = (
        await client.get(f"/api/image-sessions/{session['id']}/image-plan")
    ).json()
    assert fetched["plan"]["images"] == payload["plan"]["images"]
    assert fetched["role"] == "自定义角色"


async def test_get_image_plan_without_record(api):
    _, client, _, _ = api
    session = await create_session(client)
    response = await client.get(f"/api/image-sessions/{session['id']}/image-plan")
    assert response.status_code == 200
    assert response.json() == {"plan": None}


async def test_image_plan_session_not_found(api):
    _, client, fake, _ = api
    article, _ = await create_article_with_version(api)
    fake.decisions.append(plan_result(block_indices=[1]))
    response = await client.post(
        "/api/image-sessions/not-exist/image-plan",
        json={
            "article_id": article["id"],
            "provider": "deepseek",
            "model": "fake-model",
        },
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


async def test_image_plan_no_content(api):
    _, client, fake, _ = api
    article = (await client.post("/api/articles")).json()
    session = await create_session(client)
    fake.decisions.append(plan_result(block_indices=[1]))
    response = await client.post(
        f"/api/image-sessions/{session['id']}/image-plan",
        json={
            "article_id": article["id"],
            "provider": "deepseek",
            "model": "fake-model",
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PLAN_NO_CONTENT"


async def test_image_plan_llm_not_configured(api):
    _, client, fake, _ = api
    article, _ = await create_article_with_version(api)
    session = await create_session(client)
    fake.decisions.append(plan_result(block_indices=[1]))
    response = await client.post(
        f"/api/image-sessions/{session['id']}/image-plan",
        json={
            "article_id": article["id"],
            "provider": "deepseek",
            "model": "unknown-model",
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PLAN_LLM_NOT_CONFIGURED"


async def test_image_plan_llm_error(api):
    _, client, fake, _ = api
    article, _ = await create_article_with_version(api)
    session = await create_session(client)
    fake.decisions.append(RuntimeError("模拟的编排错误：SIMULATED_FAILURE"))
    response = await client.post(
        f"/api/image-sessions/{session['id']}/image-plan",
        json={
            "article_id": article["id"],
            "provider": "deepseek",
            "model": "fake-model",
        },
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "PLAN_LLM_ERROR"
    assert "SIMULATED_FAILURE" in response.json()["error"]["message"]
    # 失败不入库：GET 仍无记录
    fetched = (
        await client.get(f"/api/image-sessions/{session['id']}/image-plan")
    ).json()
    assert fetched == {"plan": None}


async def test_image_plan_output_truncated_hint(api):
    """ISSUE-003：输出长度超限截断时，错误提示给出调参指引而非透传 CompletionUsage。"""
    _, client, fake, _ = api
    article, _ = await create_article_with_version(api)
    session = await create_session(client)
    fake.decisions.append(
        RuntimeError(
            "Could not parse response content as the length limit was reached "
            "- CompletionUsage(completion_tokens=4096, reasoning_tokens=4095)"
        )
    )
    response = await client.post(
        f"/api/image-sessions/{session['id']}/image-plan",
        json={
            "article_id": article["id"],
            "provider": "deepseek",
            "model": "fake-model",
        },
    )
    assert response.status_code == 502
    error = response.json()["error"]
    assert error["code"] == "PLAN_LLM_ERROR"
    assert "LLM_MAX_OUTPUT_TOKENS" in error["message"]
    assert "当前 2000" in error["message"]  # fake registry 注册的上限
    assert "CompletionUsage" not in error["message"]


async def test_image_plan_empty_images(api):
    _, client, fake, _ = api
    article, _ = await create_article_with_version(api)
    session = await create_session(client)
    fake.decisions.append(plan_result(block_indices=[]))
    response = await client.post(
        f"/api/image-sessions/{session['id']}/image-plan",
        json={
            "article_id": article["id"],
            "provider": "deepseek",
            "model": "fake-model",
        },
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "PLAN_EMPTY"


async def test_image_plan_clamps_out_of_range_blocks(api):
    _, client, fake, _ = api
    article, workspace = await create_article_with_version(api)
    session = await create_session(client, article["id"])
    fake.decisions.append(plan_result(block_indices=[1, 99]))
    response = await client.post(
        f"/api/image-sessions/{session['id']}/image-plan",
        json={
            "article_id": article["id"],
            "version_id": workspace["current_version"]["id"],
            "provider": "deepseek",
            "model": "fake-model",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert [image["block_index"] for image in payload["plan"]["images"]] == [
        1,
        payload["block_count"],
    ]
