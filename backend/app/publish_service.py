"""Assemble article + images into publishable markdown and execute publishing.

The assembly flow: split the article body into H2 sections, resolve image
assets (static storage URL -> local absolute path), insert `![](path)` lines
at the requested positions, prepend wenyan frontmatter, then hand the file to
the wenyan MCP client and persist a publish record.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

from .database import NotFoundError, Repository
from .wenyan_client import PublishError, WenyanMcpClient

_H2_PATTERN = re.compile(r"^##\s+(.+?)\s*$")


def split_sections(markdown: str) -> list[dict[str, Any]]:
    """Split the body into sections by H2 headings (## ).

    Content before the first H2 becomes a leading section with heading=None;
    when no H2 exists the whole body is a single section. Sections are
    1-indexed to match the `after_section_{n}` placement positions.
    """
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in markdown.splitlines():
        match = _H2_PATTERN.match(line)
        if match:
            current = {"heading": match.group(1), "body_lines": []}
            sections.append(current)
        elif current is None:
            current = {"heading": None, "body_lines": [line]}
            sections.append(current)
        else:
            current["body_lines"].append(line)

    result: list[dict[str, Any]] = []
    for section in sections:
        body = "\n".join(section["body_lines"]).strip()
        if section["heading"] is None and not body:
            continue
        result.append(
            {"index": len(result) + 1, "heading": section["heading"], "body": body}
        )
    return result


def resolve_image_path(storage_url: str, data_dir: Path) -> str:
    """Resolve an asset storage URL into a path wenyan-mcp can consume.

    - http(s) URLs pass through unchanged.
    - `/static/assets/...` web paths map to `{data_dir}/assets/...` on disk.
    Missing local files raise PUBLISH_ASSET_MISSING to avoid dead links.
    """
    if storage_url.startswith(("http://", "https://")):
        return storage_url
    if storage_url.startswith("/static/"):
        relative = storage_url[len("/static") :].lstrip("/")
        candidate = (data_dir / relative).resolve()
        if not candidate.is_file():
            raise PublishError(
                "PUBLISH_ASSET_MISSING", f"图片文件不存在：{storage_url}"
            )
        return str(candidate)
    raise PublishError(
        "PUBLISH_ASSET_MISSING", f"无法解析图片路径：{storage_url}"
    )


def _yaml_quote(value: str) -> str:
    # JSON strings are valid YAML double-quoted scalars.
    return json.dumps(value, ensure_ascii=False)


def _section_text(section: dict[str, Any]) -> str:
    if section["heading"] is None:
        return section["body"]
    if not section["body"]:
        return f"## {section['heading']}"
    return f"## {section['heading']}\n{section['body']}"


def build_publish_markdown(
    *,
    title: str,
    content_markdown: str,
    image_placements: list[dict[str, Any]],
    assets: dict[str, dict[str, Any]],
    cover_asset_id: str | None = None,
    author: str | None = None,
    data_dir: Path,
) -> str:
    """Assemble the final markdown with frontmatter and inserted images."""
    if not title or not title.strip():
        raise PublishError("PUBLISH_TITLE_MISSING", "文章标题不能为空。")

    placements = sorted(image_placements, key=lambda item: item.get("order", 0))
    by_position: dict[str, list[str]] = {}
    for placement in placements:
        asset = assets.get(placement["asset_id"])
        if asset is None:
            raise PublishError(
                "PUBLISH_ASSET_MISSING", f"图片素材不存在：{placement['asset_id']}"
            )
        path = resolve_image_path(asset["storage_url"], data_dir)
        by_position.setdefault(placement["position"], []).append(f"![]({path})")

    sections = split_sections(content_markdown)
    parts: list[str] = []
    top_images = by_position.get("top")
    if top_images:
        parts.append("\n\n".join(top_images))
    for section in sections:
        parts.append(_section_text(section))
        images = by_position.get(f"after_section_{section['index']}")
        if images:
            parts.append("\n\n".join(images))
    bottom_images = by_position.get("bottom")
    if bottom_images:
        parts.append("\n\n".join(bottom_images))

    frontmatter = [f"title: {_yaml_quote(title.strip())}"]
    if cover_asset_id:
        cover_asset = assets.get(cover_asset_id)
        if cover_asset is None:
            raise PublishError(
                "PUBLISH_ASSET_MISSING", f"封面素材不存在：{cover_asset_id}"
            )
        frontmatter.append(
            f"cover: {_yaml_quote(resolve_image_path(cover_asset['storage_url'], data_dir))}"
        )
    if author and author.strip():
        frontmatter.append(f"author: {_yaml_quote(author.strip())}")

    frontmatter_block = "\n".join(frontmatter)
    return f"---\n{frontmatter_block}\n---\n\n" + "\n\n".join(parts)


async def execute_publish(
    *,
    repository: Repository,
    client: WenyanMcpClient,
    article_id: str,
    theme_id: str,
    version_id: str | None = None,
    image_placements: list[dict[str, Any]] | None = None,
    cover_asset_id: str | None = None,
    author: str | None = None,
    digest: str | None = None,
    edited_markdown: str | None = None,
    data_dir: Path,
) -> dict[str, str]:
    """Assemble, publish via wenyan-mcp, and persist a publish record.

    Raises PublishError on failure after recording the failed attempt; the
    record keeps the content snapshot for traceability.
    """
    article = repository.get_article(article_id)
    resolved_version_id = version_id or article.get("current_version_id")
    if not resolved_version_id:
        raise PublishError(
            "PUBLISH_NO_CONTENT", "该文章尚无可用版本，请先生成文章内容。"
        )
    version = repository.get_version(article_id, resolved_version_id)

    placements = [
        {
            "asset_id": item["asset_id"],
            "position": item["position"],
            "order": item.get("order", 0),
        }
        for item in (image_placements or [])
    ]

    if edited_markdown is not None and edited_markdown.strip():
        content = edited_markdown
    else:
        asset_ids = {item["asset_id"] for item in placements}
        if cover_asset_id:
            asset_ids.add(cover_asset_id)
        assets: dict[str, dict[str, Any]] = {}
        for asset_id in asset_ids:
            try:
                assets[asset_id] = repository.get_asset(asset_id)
            except NotFoundError:
                raise PublishError(
                    "PUBLISH_ASSET_MISSING", f"图片素材不存在：{asset_id}"
                ) from None
        content = build_publish_markdown(
            title=version["title"] or article["title"],
            content_markdown=version["content_markdown"],
            image_placements=placements,
            assets=assets,
            cover_asset_id=cover_asset_id,
            author=author,
            data_dir=data_dir,
        )

    tmp_dir = Path(data_dir) / "publish_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_file = tmp_dir / f"{uuid4()}.md"
    tmp_file.write_text(content, encoding="utf-8")

    record_kwargs = dict(
        article_id=article_id,
        version_id=resolved_version_id,
        theme_id=theme_id,
        cover_asset_id=cover_asset_id,
        author=author,
        digest=digest,
        image_placements=placements,
        content_snapshot=content,
    )
    try:
        media_id = await client.publish_article(str(tmp_file), theme_id)
    except PublishError as exc:
        repository.create_publish_record(
            status="failed",
            media_id=None,
            error_code=exc.code,
            error_message=exc.message,
            **record_kwargs,
        )
        raise
    finally:
        # 内容快照已持久化到 publish_records，临时文件用后即删（不留残留）
        tmp_file.unlink(missing_ok=True)
    record = repository.create_publish_record(
        status="succeeded", media_id=media_id, **record_kwargs
    )
    return {"publish_id": record["id"], "media_id": media_id, "status": "succeeded"}
