from __future__ import annotations

import re
from collections.abc import Iterable


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

