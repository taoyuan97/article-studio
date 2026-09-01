from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from app.main import create_app
from article_agent.config import Settings
from article_agent.models import ArticleBrief, ArticleResult, IntentDecision, UserIntent
from article_agent.registry import (
    ModelCapabilities,
    ModelRegistry,
    conservative_token_estimate,
)

from .fakes import FakeChatModel


def intent(value: UserIntent, topic: str = "测试") -> IntentDecision:
    return IntentDecision(intent=value, brief=ArticleBrief(topic=topic))


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
    fake = FakeChatModel(decisions=[], responses=[], chunk_delay=0.002)
    application = create_app(
        settings=make_settings(tmp_path),
        registry=make_registry(fake),
        data_dir=tmp_path,
    )
    async with application.router.lifespan_context(application):
        transport = httpx.ASGITransport(app=application)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            yield application, client, fake, tmp_path


async def collect_run(application, run_id: str):
    return [event async for event in application.state.manager.events(run_id)]


async def create_article(client: httpx.AsyncClient) -> dict:
    response = await client.post("/api/articles")
    assert response.status_code == 201
    return response.json()


async def start_message(client: httpx.AsyncClient, article_id: str, content: str):
    response = await client.post(
        f"/api/articles/{article_id}/messages", json={"content": content}
    )
    assert response.status_code == 202, response.text
    return response.json()


async def test_health_check(api):
    _, client, _, _ = api
    response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_create_list_generate_revise_and_checkpoint(api):
    application, client, fake, _ = api
    article = await create_article(client)
    assert article["title"] == "未命名文章"
    assert article["conversation_id"]
    assert article["thread_id"]

    listed = (await client.get("/api/articles")).json()["items"]
    assert [item["id"] for item in listed] == [article["id"]]
    assert listed[0]["version_count"] == 0

    fake.decisions.append(intent(UserIntent.GENERATE, "专注"))
    fake.responses.append("# 保持专注\n\n第一版完整正文")
    first = await start_message(client, article["id"], "直接写一篇关于专注的文章")
    first_events = await collect_run(application, first["run_id"])
    assert [event.type for event in first_events][-3:] == [
        "message.completed",
        "article.completed",
        "run.completed",
    ]
    assert application.state.manager.is_active(article["id"]) is False
    sse = await client.get(first["events_url"])
    assert sse.headers["content-type"].startswith("text/event-stream")
    assert "event: article.completed" in sse.text
    assert "event: run.completed" in sse.text

    workspace = (await client.get(f"/api/articles/{article['id']}/workspace")).json()
    assert workspace["article"]["title"] == "保持专注"
    assert workspace["current_version"]["version_number"] == 1
    assert len(workspace["messages"]) == 2
    assert workspace["thread_id"] == article["thread_id"]
    checkpoint = await application.state.manager.agent.checkpoint_values(
        thread_id=article["thread_id"]
    )
    assert checkpoint and checkpoint["current_content"] == "# 保持专注\n\n第一版完整正文"
    version_again, message_again = application.state.repository.persist_version(
        first["run_id"],
        result=ArticleResult(
            title="保持专注",
            content_markdown="# 保持专注\n\n第一版完整正文",
            kind="generation",
        ),
        brief=ArticleBrief(topic="专注"),
        summary=None,
        summary_until=None,
    )
    assert version_again["id"] == workspace["current_version"]["id"]
    assert message_again["id"] == workspace["messages"][1]["id"]

    fake.decisions.append(intent(UserIntent.REVISE, "专注"))
    fake.responses.append("# 更轻松地专注\n\n第二版完整正文")
    second = await start_message(client, article["id"], "把语气改得轻松一些")
    await collect_run(application, second["run_id"])
    versions = (await client.get(f"/api/articles/{article['id']}/versions")).json()["items"]
    assert [version["version_number"] for version in versions] == [2, 1]
    full_v2 = (
        await client.get(
            f"/api/articles/{article['id']}/versions/{versions[0]['id']}"
        )
    ).json()
    assert full_v2["parent_version_id"] == versions[1]["id"]
    assert full_v2["content_markdown"] == "# 更轻松地专注\n\n第二版完整正文"


async def test_two_articles_are_isolated_and_same_article_conflicts(api):
    application, client, fake, _ = api
    article_a = await create_article(client)
    article_b = await create_article(client)
    fake.decisions.extend(
        [intent(UserIntent.GENERATE, "A"), intent(UserIntent.GENERATE, "B")]
    )
    fake.responses.extend(
        ["# A 标题\n\n" + "A" * 200, "# B 标题\n\n" + "B" * 200]
    )
    run_a = await start_message(client, article_a["id"], "写 A")
    conflict = await client.post(
        f"/api/articles/{article_a['id']}/messages", json={"content": "再次写 A"}
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "ARTICLE_RUN_ACTIVE"
    run_b = await start_message(client, article_b["id"], "写 B")
    await asyncio.gather(
        collect_run(application, run_a["run_id"]),
        collect_run(application, run_b["run_id"]),
    )
    workspace_a = (await client.get(f"/api/articles/{article_a['id']}/workspace")).json()
    workspace_b = (await client.get(f"/api/articles/{article_b['id']}/workspace")).json()
    assert workspace_a["current_version"]["title"] == "A 标题"
    assert workspace_b["current_version"]["title"] == "B 标题"
    assert workspace_a["thread_id"] != workspace_b["thread_id"]


async def test_cancel_keeps_user_but_no_assistant_or_version(api):
    application, client, fake, _ = api
    article = await create_article(client)
    fake.decisions.append(intent(UserIntent.GENERATE, "长文"))
    fake.responses.append("# 很长\n\n" + "内容" * 1000)
    run = await start_message(client, article["id"], "生成长文")
    context = application.state.manager._runs[run["run_id"]]
    async with context.condition:
        await asyncio.wait_for(
            context.condition.wait_for(
                lambda: any(event.type == "article.delta" for event in context.events)
            ),
            timeout=2,
        )
    response = await client.post(f"/api/runs/{run['run_id']}/cancel")
    assert response.json()["cancelled"] is True
    await asyncio.sleep(0.02)
    workspace = (await client.get(f"/api/articles/{article['id']}/workspace")).json()
    assert [message["role"] for message in workspace["messages"]] == ["user"]
    assert workspace["versions"] == []
    assert workspace["current_version"] is None
    assert application.state.repository.get_run(run["run_id"])["status"] == "cancelled"


async def test_failure_is_redacted_and_retry_reuses_user_message(api):
    application, client, fake, _ = api
    article = await create_article(client)
    fake.decisions.append(intent(UserIntent.GENERATE, "失败"))
    fake.responses.append(
        RuntimeError("Authorization: Bearer test-secret-key?signature=private")
    )
    failed = await start_message(client, article["id"], "请生成后重试")
    failed_events = await collect_run(application, failed["run_id"])
    failure = next(event for event in failed_events if event.type == "run.failed")
    detail = failure.data["provider_detail"]
    assert "test-secret-key" not in detail
    assert "[REDACTED]" in detail
    failed_run = application.state.repository.get_run(failed["run_id"])
    assert "test-secret-key" not in failed_run["raw_provider_error"]

    fake.decisions.append(intent(UserIntent.GENERATE, "成功"))
    fake.responses.append("# 重试成功\n\n完整正文")
    response = await client.post(
        f"/api/articles/{article['id']}/messages/{failed['user_message_id']}/retry"
    )
    assert response.status_code == 202
    retried = response.json()
    assert retried["user_message_id"] == failed["user_message_id"]
    await collect_run(application, retried["run_id"])
    workspace = (await client.get(f"/api/articles/{article['id']}/workspace")).json()
    assert [message["role"] for message in workspace["messages"]] == [
        "user",
        "assistant",
        "assistant",
    ]
    assert workspace["messages"][1]["status"] == "failed"
    assert "test-secret-key" not in workspace["messages"][1]["provider_detail"]
    assert workspace["messages"][1]["retryable"] == 1
    assert workspace["current_version"]["title"] == "重试成功"


async def test_attachments_are_persisted_hidden_from_api_and_reused_on_retry(api):
    application, client, fake, _ = api
    article = await create_article(client)
    body = "# 访谈记录\n管理者需要清晰的沟通节奏"
    fake.decisions.append(intent(UserIntent.GENERATE, "沟通"))
    fake.responses.append(RuntimeError("temporary provider failure"))

    response = await client.post(
        f"/api/articles/{article['id']}/messages",
        json={
            "content": "根据附件写一篇文章",
            "attachments": [{"name": "访谈.md", "content": body}],
        },
    )
    assert response.status_code == 202, response.text
    failed = response.json()
    await collect_run(application, failed["run_id"])

    workspace = (await client.get(f"/api/articles/{article['id']}/workspace")).json()
    attachment = workspace["messages"][0]["attachments"][0]
    assert attachment["name"] == "访谈.md"
    assert attachment["size"] == len(body.encode("utf-8"))
    assert attachment["media_type"] == "text/markdown"
    assert "content" not in attachment
    assert workspace["messages"][1]["attachments"] == []
    stored = application.state.repository.get_message(
        failed["user_message_id"], include_attachment_content=True
    )
    assert stored["attachments"][0]["content"] == body
    assert "管理者需要清晰的沟通节奏" in "\n".join(
        str(item.content) for item in fake.invocations[-1]
    )
    assert body not in "\n".join(
        str(item.content) for item in fake.structured_invocations[-1]
    )
    assert "访谈.md" in "\n".join(
        str(item.content) for item in fake.structured_invocations[-1]
    )

    fake.decisions.append(intent(UserIntent.GENERATE, "沟通"))
    fake.responses.append("# 沟通节奏\n\n完整正文")
    retried_response = await client.post(
        f"/api/articles/{article['id']}/messages/{failed['user_message_id']}/retry"
    )
    assert retried_response.status_code == 202
    await collect_run(application, retried_response.json()["run_id"])
    after = (await client.get(f"/api/articles/{article['id']}/workspace")).json()
    assert [item["role"] for item in after["messages"]] == [
        "user",
        "assistant",
        "assistant",
    ]
    assert after["messages"][0]["attachments"] == workspace["messages"][0]["attachments"]
    assert "管理者需要清晰的沟通节奏" in "\n".join(
        str(item.content) for item in fake.invocations[-1]
    )
    checkpoint = await application.state.manager.agent.checkpoint_values(
        thread_id=article["thread_id"]
    )
    assert checkpoint is not None
    assert "管理者需要清晰的沟通节奏" not in str(checkpoint)


@pytest.mark.parametrize(
    ("attachments", "code"),
    [
        (
            [{"name": f"{index}.txt", "content": "ok"} for index in range(6)],
            "ARTICLE_ATTACHMENT_COUNT_INVALID",
        ),
        ([{"name": "../bad.txt", "content": "ok"}], "ARTICLE_ATTACHMENT_NAME_INVALID"),
        ([{"name": "bad.pdf", "content": "ok"}], "ARTICLE_ATTACHMENT_TYPE_INVALID"),
        ([{"name": "empty.txt", "content": ""}], "ARTICLE_ATTACHMENT_CONTENT_INVALID"),
        (
            [{"name": "large.txt", "content": "a" * (200 * 1024 + 1)}],
            "ARTICLE_ATTACHMENT_SIZE_INVALID",
        ),
        (
            [{"name": "chars.txt", "content": "a" * 120_001}],
            "ARTICLE_ATTACHMENT_CONTENT_INVALID",
        ),
    ],
)
async def test_attachment_validation_is_atomic(api, attachments, code):
    application, client, _, _ = api
    article = await create_article(client)
    response = await client.post(
        f"/api/articles/{article['id']}/messages",
        json={"content": "参考附件", "attachments": attachments},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == code
    assert application.state.repository.workspace(article["id"])["messages"] == []


async def test_five_attachments_and_boundaries_are_accepted(api):
    application, client, fake, _ = api
    article = await create_article(client)
    fake.decisions.append(intent(UserIntent.UNRELATED_CHAT))
    response = await client.post(
        f"/api/articles/{article['id']}/messages",
        json={
            "content": "保存附件",
            "attachments": [
                {"name": f"notes-{index}.TXT", "content": "a" * 24_000}
                for index in range(5)
            ],
        },
    )
    assert response.status_code == 202, response.text
    await collect_run(application, response.json()["run_id"])
    workspace = (await client.get(f"/api/articles/{article['id']}/workspace")).json()
    assert len(workspace["messages"][0]["attachments"]) == 5
    assert all(
        item["media_type"] == "text/plain"
        for item in workspace["messages"][0]["attachments"]
    )


async def test_current_attachment_context_overflow_has_specific_failure(api):
    application, client, fake, _ = api
    article = await create_article(client)
    fake.decisions.append(intent(UserIntent.GENERATE, "超长资料"))
    response = await client.post(
        f"/api/articles/{article['id']}/messages",
        json={
            "content": "根据完整附件生成文章",
            "attachments": [{"name": "long.txt", "content": "a" * 100_000}],
        },
    )
    assert response.status_code == 202
    events = await collect_run(application, response.json()["run_id"])
    failure = next(event for event in events if event.type == "run.failed")
    assert failure.data["message"] == (
        "当前正文、最新指令、完整附件和生成预算已超过模型安全上下文；"
        "请缩短文章或资料、缩小修改范围、拆分发送，或切换更大上下文模型。"
    )
    run = application.state.repository.get_run(response.json()["run_id"])
    assert run["error_code"] == "ARTICLE_CONTEXT_TOO_LARGE"
    assert fake.invocations == []


async def test_message_cursor_pagination(api):
    application, client, fake, _ = api
    article = await create_article(client)
    for index in range(3):
        fake.decisions.append(intent(UserIntent.UNRELATED_CHAT))
        run = await start_message(client, article["id"], f"无关问题 {index}")
        await collect_run(application, run["run_id"])
    newest_page = (
        await client.get(f"/api/articles/{article['id']}/messages?limit=2")
    ).json()
    assert len(newest_page["items"]) == 2
    older_page = (
        await client.get(
            f"/api/articles/{article['id']}/messages?limit=2&before={newest_page['next_cursor']}"
        )
    ).json()
    assert len(older_page["items"]) == 2
    assert older_page["items"][-1]["sequence_number"] < newest_page["items"][0]["sequence_number"]


async def test_checkpoint_write_failure_does_not_hide_run_completed(api, monkeypatch):
    application, client, fake, _ = api
    article = await create_article(client)
    fake.decisions.append(intent(UserIntent.UNRELATED_CHAT))

    async def broken_checkpoint(*args, **kwargs):
        raise RuntimeError("checkpoint unavailable")

    monkeypatch.setattr(application.state.manager, "_checkpoint_current", broken_checkpoint)
    run = await start_message(client, article["id"], "无关问题")
    events = await collect_run(application, run["run_id"])
    assert [event.type for event in events][-2:] == [
        "message.completed",
        "run.completed",
    ]
    assert application.state.manager.is_active(article["id"]) is False


async def test_list_is_limited_to_latest_hundred_and_database_has_no_keys(api):
    application, client, _, data_dir = api
    repository = application.state.repository
    for _ in range(105):
        repository.create_article("deepseek", "fake-model")
    response = await client.get("/api/articles")
    assert response.status_code == 200
    assert len(response.json()["items"]) == 100
    assert (
        await client.get("/api/articles?limit=101")
    ).status_code == 422
    database_bytes = (data_dir / "article.sqlite3").read_bytes()
    checkpoint_bytes = (data_dir / "checkpoints.sqlite3").read_bytes()
    assert b"test-secret-key" not in database_bytes
    assert b"test-secret-key" not in checkpoint_bytes


async def test_checkpoint_loss_rebuilds_from_business_database(tmp_path):
    fake = FakeChatModel(
        decisions=[intent(UserIntent.GENERATE, "恢复")],
        responses=["# 可恢复\n\n持久化正文"],
    )
    settings = make_settings(tmp_path)
    first_app = create_app(
        settings=settings, registry=make_registry(fake), data_dir=tmp_path
    )
    article_id = thread_id = ""
    async with first_app.router.lifespan_context(first_app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=first_app), base_url="http://test"
        ) as client:
            article = await create_article(client)
            article_id, thread_id = article["id"], article["thread_id"]
            run = await start_message(client, article_id, "生成可恢复文章")
            await collect_run(first_app, run["run_id"])
            await first_app.state.manager.agent.checkpointer.adelete_thread(thread_id)
            assert (
                await first_app.state.manager.agent.checkpoint_values(thread_id=thread_id)
                is None
            )

    second_fake = FakeChatModel(
        decisions=[intent(UserIntent.REVISE, "恢复")],
        responses=["# 恢复后修改\n\n新的完整正文"],
    )
    second_app = create_app(
        settings=settings, registry=make_registry(second_fake), data_dir=tmp_path
    )
    async with second_app.router.lifespan_context(second_app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=second_app), base_url="http://test"
        ) as client:
            before = (await client.get(f"/api/articles/{article_id}/workspace")).json()
            assert before["current_version"]["content_markdown"] == "# 可恢复\n\n持久化正文"
            run = await start_message(client, article_id, "继续修改")
            await collect_run(second_app, run["run_id"])
            after = (await client.get(f"/api/articles/{article_id}/workspace")).json()
            assert after["current_version"]["version_number"] == 2
            assert after["thread_id"] == thread_id


async def test_serve_frontend_spa_fallback(tmp_path):
    dist_dir = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if not (dist_dir / "index.html").is_file():
        pytest.skip("frontend/dist not built; run `pnpm build` in frontend/ first")

    settings = make_settings(tmp_path)
    settings.serve_frontend = True
    fake = FakeChatModel(decisions=[], responses=[])
    application = create_app(
        settings=settings, registry=make_registry(fake), data_dir=tmp_path
    )
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://test"
        ) as client:
            root = await client.get("/")
            assert root.status_code == 200
            assert 'id="root"' in root.text

            deep_link = await client.get("/articles")
            assert deep_link.status_code == 200
            assert 'id="root"' in deep_link.text

            api_miss = await client.get("/api/nonexistent")
            assert api_miss.status_code == 404
