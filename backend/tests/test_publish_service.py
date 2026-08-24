from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio

from app.main import create_app
from app.publish_service import (
    PublishError,
    build_publish_markdown,
    resolve_image_path,
    split_sections,
)
from app.wenyan_client import WenyanMcpClient
from article_agent.config import Settings
from article_agent.image_providers import ImageProviderRegistry
from article_agent.registry import (
    ModelCapabilities,
    ModelRegistry,
    conservative_token_estimate,
)

from .fakes import FakeChatModel, FakeImageProvider


# ---------------------------------------------------------------- split_sections


def test_split_sections_with_h2():
    markdown = "intro text\n\n## Alpha\nalpha body\n\n## Beta\nbeta body"
    sections = split_sections(markdown)
    assert sections == [
        {"index": 1, "heading": None, "body": "intro text"},
        {"index": 2, "heading": "Alpha", "body": "alpha body"},
        {"index": 3, "heading": "Beta", "body": "beta body"},
    ]


def test_split_sections_without_h2_is_single_section():
    sections = split_sections("para1\n\npara2")
    assert sections == [{"index": 1, "heading": None, "body": "para1\n\npara2"}]


def test_split_sections_consecutive_h2():
    sections = split_sections("## A\n\n## B\nb body")
    assert [s["heading"] for s in sections] == ["A", "B"]
    assert sections[0]["body"] == ""
    assert sections[1]["body"] == "b body"


def test_split_sections_empty_markdown():
    assert split_sections("") == []
    assert split_sections("   \n\n  ") == []


def test_split_sections_ignores_h3_and_h1():
    markdown = "# Title\n\n### Sub\n\n## Real"
    sections = split_sections(markdown)
    assert len(sections) == 2
    assert sections[0]["heading"] is None
    assert "# Title" in sections[0]["body"]
    assert sections[1]["heading"] == "Real"


# ------------------------------------------------------- build_publish_markdown


@pytest.fixture
def asset_env(tmp_path: Path):
    def make_asset(name: str) -> tuple[str, dict]:
        relative = f"images/{name}.png"
        file_path = tmp_path / "assets" / relative
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(b"\x89PNG fake")
        asset_id = f"asset-{name}"
        return asset_id, {"id": asset_id, "storage_url": f"/static/assets/{relative}"}

    a1_id, a1 = make_asset("cover")
    a2_id, a2 = make_asset("mid1")
    a3_id, a3 = make_asset("mid2")
    assets = {a1_id: a1, a2_id: a2, a3_id: a3}
    return tmp_path, assets, {a1_id, a2_id, a3_id}


def test_build_publish_markdown_frontmatter(asset_env):
    data_dir, assets, _ = asset_env
    markdown = build_publish_markdown(
        title="保持「专注」",
        content_markdown="正文一段",
        image_placements=[{"asset_id": "asset-cover", "position": "top", "order": 0}],
        assets=assets,
        cover_asset_id="asset-cover",
        author="作者甲",
        data_dir=data_dir,
    )
    head, body = markdown.split("\n---\n", 1)
    assert head.startswith('---\ntitle: "保持「专注」"')
    expected_cover = json.dumps(
        str((data_dir / "assets" / "images" / "cover.png").resolve()), ensure_ascii=False
    )
    assert f"cover: {expected_cover}" in head
    assert head.endswith('author: "作者甲"')
    assert body.startswith("\n![](")
    assert "正文一段" in markdown


def test_build_publish_markdown_insert_positions_and_order(asset_env):
    data_dir, assets, _ = asset_env
    content = "intro\n\n## One\none body\n\n## Two\ntwo body"
    markdown = build_publish_markdown(
        title="标题",
        content_markdown=content,
        image_placements=[
            # Sections: 1=intro(无标题), 2=One, 3=Two → after_section_3 在 Two 之后。
            {"asset_id": "asset-mid2", "position": "after_section_3", "order": 2},
            {"asset_id": "asset-mid1", "position": "after_section_3", "order": 1},
            {"asset_id": "asset-cover", "position": "top", "order": 0},
        ],
        assets=assets,
        data_dir=data_dir,
    )
    lines = markdown.splitlines()
    body_start = lines.index("---", 1) + 1  # after frontmatter block
    body = "\n".join(lines[body_start:])

    top_img = str((data_dir / "assets/images/cover.png").resolve())
    first_image = body.lstrip("\n").split("\n\n")[0]
    assert first_image == f"![]({top_img})"

    # Same position keeps order: mid1 (order 1) before mid2 (order 2), both after section 3.
    mid1 = str((data_dir / "assets/images/mid1.png").resolve())
    mid2 = str((data_dir / "assets/images/mid2.png").resolve())
    assert body.index("two body") < body.index(f"![]({mid1})") < body.index(f"![]({mid2})")
    assert body.index("intro") < body.index("## One") < body.index("one body") < body.index("## Two")


def test_build_publish_markdown_bottom_and_no_images(asset_env):
    data_dir, assets, _ = asset_env
    markdown = build_publish_markdown(
        title="纯文字",
        content_markdown="只有正文",
        image_placements=[],
        assets={},
        data_dir=data_dir,
    )
    assert markdown == '---\ntitle: "纯文字"\n---\n\n只有正文'

    with_bottom = build_publish_markdown(
        title="文末图",
        content_markdown="正文",
        image_placements=[{"asset_id": "asset-cover", "position": "bottom", "order": 0}],
        assets=assets,
        data_dir=data_dir,
    )
    bottom_img = str((data_dir / "assets/images/cover.png").resolve())
    assert with_bottom.rstrip().endswith(f"![]({bottom_img})")


def test_build_publish_markdown_missing_local_file(asset_env):
    data_dir, _, _ = asset_env
    ghost = {"id": "ghost", "storage_url": "/static/assets/images/nope.png"}
    with pytest.raises(PublishError) as exc_info:
        build_publish_markdown(
            title="t",
            content_markdown="正文",
            image_placements=[{"asset_id": "ghost", "position": "top", "order": 0}],
            assets={"ghost": ghost},
            data_dir=data_dir,
        )
    assert exc_info.value.code == "PUBLISH_ASSET_MISSING"


def test_build_publish_markdown_unknown_asset(asset_env):
    data_dir, _, _ = asset_env
    with pytest.raises(PublishError) as exc_info:
        build_publish_markdown(
            title="t",
            content_markdown="正文",
            image_placements=[{"asset_id": "unknown", "position": "top", "order": 0}],
            assets={},
            data_dir=data_dir,
        )
    assert exc_info.value.code == "PUBLISH_ASSET_MISSING"


def test_resolve_image_path_http_passthrough():
    assert (
        resolve_image_path("https://example.com/a.png", Path("data"))
        == "https://example.com/a.png"
    )


def test_resolve_image_path_unsupported_scheme():
    with pytest.raises(PublishError) as exc_info:
        resolve_image_path("ftp://example.com/a.png", Path("data"))
    assert exc_info.value.code == "PUBLISH_ASSET_MISSING"


# ------------------------------------------------------------ API integration


def make_settings(data_dir, **overrides) -> Settings:
    defaults = dict(
        _env_file=None,
        default_llm_provider="deepseek",
        deepseek_api_key="test-secret-key",
        deepseek_model="fake-model",
        deepseek_context_window=32_000,
        data_dir=data_dir,
        publish_fake_mode=True,
        wechat_app_id="fake-app-id",
        wechat_app_secret="fake-secret",
    )
    defaults.update(overrides)
    return Settings(**defaults)


def make_app(tmp_path, **settings_overrides):
    fake = FakeChatModel(decisions=[], responses=[], chunk_delay=0)
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
    image_registry = ImageProviderRegistry()
    image_registry.register("fake", FakeImageProvider(data_dir=tmp_path))
    return create_app(
        settings=make_settings(tmp_path, **settings_overrides),
        registry=registry,
        image_registry_override=image_registry,
        data_dir=tmp_path,
    )


@pytest_asyncio.fixture
async def api(tmp_path):
    application = make_app(tmp_path)
    async with application.router.lifespan_context(application):
        from httpx import ASGITransport, AsyncClient

        async with AsyncClient(
            transport=ASGITransport(app=application), base_url="http://test"
        ) as client:
            yield application, client, tmp_path


def seed_version(application, article_id: str, title: str, content: str) -> str:
    repository = application.state.repository
    version_id = str(uuid4())
    with repository.transaction() as connection:
        connection.execute(
            """INSERT INTO article_versions
               (id,article_id,parent_version_id,version_number,title,content_markdown,
                instruction,provider,model,run_id,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                version_id, article_id, None, 1, title, content,
                "test", "deepseek", "fake-model", str(uuid4()), "2026-01-01T00:00:00+00:00",
            ),
        )
        connection.execute(
            "UPDATE articles SET current_version_id=?,title=?,status='generated' WHERE id=?",
            (version_id, title, article_id),
        )
    return version_id


def seed_asset(application, tmp_path: Path, name: str) -> str:
    repository = application.state.repository
    asset_id = str(uuid4())
    relative = f"images/{name}.png"
    file_path = tmp_path / "assets" / relative
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_bytes(b"\x89PNG fake")
    timestamp = "2026-01-01T00:00:00+00:00"
    with repository.transaction() as connection:
        connection.execute(
            """INSERT INTO assets
               (id,kind,source,source_session_id,source_message_id,title,storage_url,
                provider,model,metadata_json,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                asset_id, "image", "image_generation", None, None, name,
                f"/static/assets/{relative}", "fake", "fake-image-model", "{}",
                timestamp, timestamp,
            ),
        )
    return asset_id


async def make_article_with_version(api, title="测试文章", content="导语\n\n## 一\n正文一\n\n## 二\n正文二"):
    application, client, tmp_path = api
    article = (await client.post("/api/articles")).json()
    version_id = seed_version(application, article["id"], title, content)
    return article, version_id


async def test_publish_themes_fake_mode(api):
    _, client, _ = api
    response = await client.get("/api/publish/themes")
    assert response.status_code == 200
    themes = response.json()["items"]
    assert len(themes) == 8
    assert themes[0]["id"] == "default"


async def test_publish_preview_returns_sections_and_markdown(api):
    application, client, tmp_path = api
    article, version_id = await make_article_with_version(api)
    asset_id = seed_asset(application, tmp_path, "cover")

    response = await client.post("/api/publish/preview", json={
        "article_id": article["id"],
        "image_placements": [{"asset_id": asset_id, "position": "top", "order": 0}],
        "cover_asset_id": asset_id,
        "author": "作者",
    })
    assert response.status_code == 200, response.text
    data = response.json()
    assert [s["heading"] for s in data["sections"]] == [None, "一", "二"]
    assert data["markdown"].startswith("---\n")
    assert 'title: "测试文章"' in data["markdown"]
    assert "![](" in data["markdown"]


async def test_publish_success_writes_record_with_fake_media_id(api):
    application, client, tmp_path = api
    article, version_id = await make_article_with_version(api)
    asset_id = seed_asset(application, tmp_path, "pic")

    response = await client.post(f"/api/publish/articles/{article['id']}", json={
        "theme_id": "orangeheart",
        "image_placements": [{"asset_id": asset_id, "position": "after_section_1", "order": 0}],
        "author": "作者",
        "digest": "摘要",
    })
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["status"] == "succeeded"
    assert data["media_id"].startswith("FAKE_MEDIA_")
    assert data["publish_id"]

    records = (await client.get(f"/api/publish/records?article_id={article['id']}")).json()["items"]
    assert len(records) == 1
    record = records[0]
    assert record["article_title"] == "测试文章"
    assert record["status"] == "succeeded"
    assert record["theme_id"] == "orangeheart"
    assert record["media_id"].startswith("FAKE_MEDIA_")
    assert record["image_placements"][0]["asset_id"] == asset_id

    detail = (await client.get(f"/api/publish/records/{data['publish_id']}")).json()
    assert detail["content_snapshot"].startswith("---\n")
    assert 'title: "测试文章"' in detail["content_snapshot"]

    # 快照已入库，publish_tmp 临时文件用后即删，不留残留
    assert not list((tmp_path / "publish_tmp").glob("*.md"))


async def test_publish_failure_marker_writes_failed_record(api):
    # 正文含「触发发布失败」→ fake 模式抛 PUBLISH_MCP_ERROR（502），落失败记录
    application, client, tmp_path = api
    article, _ = await make_article_with_version(
        api, content="导语\n\n## 一\n正文一\n\n触发发布失败\n"
    )

    response = await client.post(f"/api/publish/articles/{article['id']}", json={
        "theme_id": "default",
    })
    assert response.status_code == 502, response.text
    assert response.json()["error"]["code"] == "PUBLISH_MCP_ERROR"

    records = (await client.get(f"/api/publish/records?article_id={article['id']}")).json()["items"]
    assert len(records) == 1
    record = records[0]
    assert record["status"] == "failed"
    assert record["error_code"] == "PUBLISH_MCP_ERROR"
    assert "40164" in record["error_message"]
    assert record["media_id"] is None
    # 失败也保留快照且不留临时文件
    assert record["content_snapshot"].startswith("---\n")
    assert not list((tmp_path / "publish_tmp").glob("*.md"))


async def test_publish_records_without_article_id_returns_all(api):
    application, client, tmp_path = api
    first, _ = await make_article_with_version(api, title="文章一")
    second, _ = await make_article_with_version(api, title="文章二")
    for article in (first, second):
        response = await client.post(f"/api/publish/articles/{article['id']}", json={
            "theme_id": "default",
        })
        assert response.status_code == 200, response.text

    all_records = (await client.get("/api/publish/records")).json()["items"]
    assert len(all_records) == 2
    assert {r["article_title"] for r in all_records} == {"文章一", "文章二"}

    only_first = (await client.get(f"/api/publish/records?article_id={first['id']}")).json()["items"]
    assert len(only_first) == 1
    assert only_first[0]["article_title"] == "文章一"


async def test_publish_credentials_missing_passthrough(tmp_path):
    application = make_app(tmp_path, wechat_app_id="", wechat_app_secret="")
    async with application.router.lifespan_context(application):
        from httpx import ASGITransport, AsyncClient

        async with AsyncClient(
            transport=ASGITransport(app=application), base_url="http://test"
        ) as client:
            article = (await client.post("/api/articles")).json()
            seed_version(application, article["id"], "标题", "正文")

            response = await client.post(f"/api/publish/articles/{article['id']}", json={
                "theme_id": "default",
            })
            assert response.status_code == 422, response.text
            error = response.json()["error"]
            assert error["code"] == "PUBLISH_CREDENTIALS_MISSING"

            # Failed attempts are still recorded for traceability.
            records = (await client.get("/api/publish/records")).json()["items"]
            assert len(records) == 1
            assert records[0]["status"] == "failed"
            assert records[0]["error_code"] == "PUBLISH_CREDENTIALS_MISSING"


async def test_publish_edited_markdown_takes_precedence(api):
    application, client, _ = api
    article, version_id = await make_article_with_version(api)
    edited = "---\ntitle: \"手改标题\"\n---\n\n手改正文"

    response = await client.post(f"/api/publish/articles/{article['id']}", json={
        "theme_id": "default",
        "edited_markdown": edited,
    })
    assert response.status_code == 200, response.text
    publish_id = response.json()["publish_id"]

    detail = (await client.get(f"/api/publish/records/{publish_id}")).json()
    assert detail["content_snapshot"] == edited


async def test_publish_preview_article_not_found(api):
    _, client, _ = api
    response = await client.post("/api/publish/preview", json={"article_id": "missing"})
    assert response.status_code == 404


async def test_publish_invalid_position_rejected(api):
    application, client, tmp_path = api
    article, _ = await make_article_with_version(api)
    asset_id = seed_asset(application, tmp_path, "pic")

    response = await client.post("/api/publish/preview", json={
        "article_id": article["id"],
        "image_placements": [{"asset_id": asset_id, "position": "middle", "order": 0}],
    })
    assert response.status_code == 422
    assert "position" in response.text
