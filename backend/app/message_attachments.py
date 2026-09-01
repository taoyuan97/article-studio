from __future__ import annotations

from pathlib import PurePath
from typing import Any

from pydantic import BaseModel


MAX_ATTACHMENT_COUNT = 5
MAX_ATTACHMENT_BYTES = 200 * 1024
MAX_ATTACHMENTS_BYTES_TOTAL = 1000 * 1024
MAX_ATTACHMENT_CHARS_TOTAL = 120_000
ATTACHMENT_MEDIA_TYPES = {".md": "text/markdown", ".txt": "text/plain"}


class MessageAttachmentRequest(BaseModel):
    name: str
    content: str


class AttachmentValidationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _invalid(code: str, message: str) -> AttachmentValidationError:
    return AttachmentValidationError(code, message)


def validate_attachments(
    attachments: list[MessageAttachmentRequest],
) -> list[dict[str, Any]]:
    if len(attachments) > MAX_ATTACHMENT_COUNT:
        raise _invalid(
            "ARTICLE_ATTACHMENT_COUNT_INVALID", "单次最多上传 5 个附件"
        )

    normalized: list[dict[str, Any]] = []
    total_bytes = 0
    total_chars = 0
    for attachment in attachments:
        name = attachment.name.strip()
        if (
            not name
            or "\x00" in name
            or "/" in name
            or "\\" in name
            or PurePath(name).name != name
        ):
            raise _invalid("ARTICLE_ATTACHMENT_NAME_INVALID", "附件文件名无效")

        suffix = PurePath(name).suffix.lower()
        media_type = ATTACHMENT_MEDIA_TYPES.get(suffix)
        if media_type is None:
            raise _invalid(
                "ARTICLE_ATTACHMENT_TYPE_INVALID", "仅支持 .md 和 .txt 文件"
            )

        content = attachment.content.removeprefix("\ufeff")
        if not content or "\x00" in content:
            raise _invalid(
                "ARTICLE_ATTACHMENT_CONTENT_INVALID", "附件内容为空或无效"
            )

        size = len(content.encode("utf-8"))
        if size > MAX_ATTACHMENT_BYTES:
            raise _invalid(
                "ARTICLE_ATTACHMENT_SIZE_INVALID", "单个附件不能超过 200 KB"
            )

        total_bytes += size
        total_chars += len(content)
        if total_bytes > MAX_ATTACHMENTS_BYTES_TOTAL:
            raise _invalid(
                "ARTICLE_ATTACHMENT_SIZE_INVALID", "附件合计不能超过 1000 KB"
            )
        if total_chars > MAX_ATTACHMENT_CHARS_TOTAL:
            raise _invalid(
                "ARTICLE_ATTACHMENT_CONTENT_INVALID",
                "附件正文合计不能超过 120000 字符",
            )

        normalized.append(
            {
                "name": name,
                "media_type": media_type,
                "size": size,
                "content": content,
            }
        )
    return normalized
