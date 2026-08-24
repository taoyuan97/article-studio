"""Assemble article + images into publishable markdown and execute publishing.

The assembly flow: split the article body into H2 sections then top-level
blocks, resolve image assets (static storage URL -> local absolute path),
insert `![](path)` lines at the requested positions (`after_block_{n}` from
the canvas wizard; `top` / `bottom` / `after_section_{n}` kept for backward
compatibility), prepend wenyan frontmatter, then hand the file to the wenyan
MCP client and persist a publish record.
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
_ATX_HEADING_PATTERN = re.compile(r"^#{1,6}(\s|$)")
_FENCE_OPEN_PATTERN = re.compile(r"^(\s*)(`{3,}|~{3,})")
_AFTER_BLOCK_PATTERN = re.compile(r"^after_block_(\d+)$")


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


def _walk_blocks(markdown: str) -> list[dict[str, Any]]:
    """One pass over lines: fence-aware top-level blocks with raw section spans.

    - Blocks are separated by blank lines; ATX headings and fenced code
      openers start new blocks; lines inside a fence never split it (internal
      blank lines preserved, closing fence must match the opening marker).
    - Raw section counting mirrors `split_sections` (H2 lines increment the
      counter even inside fences), so legacy `after_section_{n}` numbering is
      unchanged. Each block records the raw section of its first/last line;
      a fence spanning H2s simply covers several sections.
    """
    blocks: list[dict[str, Any]] = []
    current_lines: list[str] = []
    current_start_section = 0
    raw_section = 0
    fence_marker: str | None = None
    heading_only = False

    def flush() -> None:
        nonlocal current_lines, heading_only
        if current_lines:
            blocks.append(
                {
                    "text": "\n".join(current_lines),
                    "start_section": current_start_section,
                    "end_section": raw_section,
                }
            )
        current_lines = []
        heading_only = False

    for line in markdown.splitlines():
        if fence_marker is not None:
            current_lines.append(line)
            if _H2_PATTERN.match(line):
                raw_section += 1
            stripped = line.strip()
            if (
                stripped
                and stripped[0] == fence_marker[0]
                and len(stripped) >= len(fence_marker)
                and set(stripped) == {fence_marker[0]}
            ):
                fence_marker = None
                flush()
            continue
        if _H2_PATTERN.match(line):
            flush()
            raw_section += 1
            current_start_section = raw_section
            current_lines = [line]
            heading_only = True
            continue
        if not line.strip():
            flush()
            continue
        fence_match = _FENCE_OPEN_PATTERN.match(line)
        if fence_match:
            flush()
            current_start_section = raw_section
            current_lines = [line]
            fence_marker = fence_match.group(2)
            continue
        if _ATX_HEADING_PATTERN.match(line):
            flush()
            current_start_section = raw_section
            current_lines = [line]
            heading_only = True
            continue
        if heading_only:
            # 标题是叶子块：其后内容另起新块
            flush()
        if not current_lines:
            current_start_section = raw_section
        current_lines.append(line)
    flush()
    return blocks


def _block_kind(text: str) -> str:
    first_line = text.split("\n", 1)[0]
    if _ATX_HEADING_PATTERN.match(first_line):
        return "heading"
    if _FENCE_OPEN_PATTERN.match(first_line):
        return "code"
    stripped = first_line.strip()
    if stripped.startswith(">"):
        return "quote"
    if re.match(r"^(\s*)([-*+]|\d{1,9}[.)])\s", first_line):
        return "list"
    if stripped.startswith("|"):
        return "table"
    if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", stripped):
        return "divider"
    return "paragraph"


def _block_preview(text: str) -> str:
    lines = text.split("\n")
    source = lines[0]
    if _FENCE_OPEN_PATTERN.match(source) and len(lines) > 1:
        source = lines[1]
    cleaned = re.sub(r"^(#{1,6}\s+|>\s*|[-*+]\s+|\d{1,9}[.)]\s+)", "", source.strip())
    return cleaned[:40] + ("…" if len(cleaned) > 40 else "")


def split_blocks(markdown: str) -> list[dict[str, Any]]:
    """Top-level blocks with 1-based global indices for the preview API.

    Blocks are the insert anchors for `after_block_{n}` placements; the
    numbering is identical to what `build_publish_markdown` uses (both walk
    `_walk_blocks`), so frontend anchors never drift from assembly. `text`
    carries the full block markdown so the frontend canvas renders blocks
    without re-splitting the article.
    """
    result: list[dict[str, Any]] = []
    for block in _walk_blocks(markdown):
        result.append(
            {
                "index": len(result) + 1,
                "kind": _block_kind(block["text"]),
                "preview": _block_preview(block["text"]),
                "text": block["text"],
            }
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

    blocks = _walk_blocks(content_markdown)
    total_blocks = len(blocks)
    for position in by_position:
        block_match = _AFTER_BLOCK_PATTERN.match(position)
        if block_match and int(block_match.group(1)) > total_blocks:
            raise PublishError(
                "PUBLISH_PLACEMENT_INVALID",
                f"图片插入位置越界：{position}（正文共 {total_blocks} 个块）",
            )

    # 小节重编号：导语有内容时导语=1（与 split_sections 丢弃空导语的行为一致）
    section_offset = 1 if any(b["start_section"] == 0 for b in blocks) else 0

    parts: list[str] = []
    top_images = by_position.get("top")
    if top_images:
        parts.append("\n\n".join(top_images))
    for i, block in enumerate(blocks):
        parts.append(block["text"])
        block_images = by_position.get(f"after_block_{i + 1}")
        if block_images:
            parts.append("\n\n".join(block_images))
        # 该块是其覆盖范围内各小节的最后一个块 → 小节图插在其后
        start_section = block["start_section"] + section_offset
        end_section = block["end_section"] + section_offset
        next_start = (
            blocks[i + 1]["start_section"] + section_offset
            if i + 1 < len(blocks)
            else None
        )
        last_closed = end_section if next_start is None else min(end_section, next_start - 1)
        for section_no in range(start_section, last_closed + 1):
            section_images = by_position.get(f"after_section_{section_no}")
            if section_images:
                parts.append("\n\n".join(section_images))
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
