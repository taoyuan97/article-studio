from __future__ import annotations

import re
from collections.abc import Iterable

from fastapi import HTTPException, Request


_HEADER_PATTERN = re.compile(
    r"(?i)\b(authorization|cookie|set-cookie|x-api-key)\b\s*[:=]\s*([^\s,;]+)"
)
_BEARER_PATTERN = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
_SIGNED_QUERY_PATTERN = re.compile(
    r"(?i)([?&](?:signature|sig|token|api[_-]?key|access[_-]?key)=)[^&#\s]+"
)


def redact_sensitive(value: object, secrets: Iterable[str] = ()) -> str:
    text = str(value)
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    text = _HEADER_PATTERN.sub(lambda match: f"{match.group(1)}: [REDACTED]", text)
    text = _BEARER_PATTERN.sub("Bearer [REDACTED]", text)
    text = _SIGNED_QUERY_PATTERN.sub(lambda match: match.group(1) + "[REDACTED]", text)
    return text[:4000]


def require_local_origin(request: Request) -> None:
    """Protect sensitive settings mutations from cross-site browser requests."""

    origin = request.headers.get("origin")
    client_host = request.client.host if request.client else ""
    local_hosts = {"127.0.0.1", "::1", "localhost", "testclient"}
    if not origin:
        if client_host in local_hosts:
            return
        raise HTTPException(
            status_code=403,
            detail={"code": "SETTINGS_ORIGIN_FORBIDDEN", "message": "设置操作仅允许本机访问"},
            headers={"Cache-Control": "no-store"},
        )
    allowed = {
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        f"{request.url.scheme}://{request.headers.get('host', '')}",
    }
    if origin.rstrip("/") not in {item.rstrip("/") for item in allowed}:
        raise HTTPException(
            status_code=403,
            detail={"code": "SETTINGS_ORIGIN_FORBIDDEN", "message": "设置操作来源不受信任"},
            headers={"Cache-Control": "no-store"},
        )
