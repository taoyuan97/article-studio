from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Iterable

from article_agent.config import Settings


class SettingsRevisionConflictError(ValueError):
    pass


class SettingsStore:
    """Thread-safe `.env` baseline plus DATA_DIR/settings.json overrides."""

    PROVIDER_FIELDS: dict[str, tuple[str, ...]] = {
        "llm_deepseek": (
            "deepseek_api_key",
            "deepseek_base_url",
            "deepseek_model",
            "deepseek_context_window",
        ),
        "llm_moonshot": (
            "moonshot_api_key",
            "moonshot_base_url",
            "moonshot_model",
            "moonshot_context_window",
        ),
        "image_wanxiang": (
            "aliyun_wanxiang_api_key",
            "aliyun_wanxiang_base_url",
            "aliyun_wanxiang_model",
        ),
    }
    CREDENTIAL_FIELDS: dict[str, tuple[str, ...]] = {
        "llm_deepseek": ("deepseek_api_key",),
        "llm_moonshot": ("moonshot_api_key",),
        "image_wanxiang": ("aliyun_wanxiang_api_key",),
        "wechat": ("wechat_app_id", "wechat_app_secret"),
    }
    DEFAULT_FIELDS = ("default_llm_provider", "default_image_provider")
    RUNTIME_FIELDS = (
        "llm_timeout_seconds",
        "llm_max_retries",
        "llm_max_output_tokens",
        "llm_context_usage_ratio",
        "llm_recent_message_limit",
        "image_timeout_seconds",
    )
    WECHAT_FIELDS = ("wechat_app_id", "wechat_app_secret")

    def __init__(self, base: Settings, path: Path) -> None:
        self.path = Path(path)
        self._base = base
        self._overrides: dict[str, Any] = {}
        self._revision = 0
        self._lock = threading.RLock()
        self._load()
        self._current = self._build(self._overrides)

    @property
    def current(self) -> Settings:
        with self._lock:
            return self._current

    @property
    def revision(self) -> int:
        with self._lock:
            return self._revision

    def has_override(self, field: str) -> bool:
        with self._lock:
            return field in self._overrides

    def credential_source(self, group: str) -> str | None:
        fields = self.CREDENTIAL_FIELDS[group]
        current = self.current
        if not all(self._plain_value(getattr(current, field)) for field in fields):
            return None
        count = sum(self.has_override(field) for field in fields)
        if count == len(fields):
            return "runtime"
        if count:
            return "mixed"
        return "env"

    def reveal_override(self, field: str, *, expected_revision: int) -> str:
        with self._lock:
            self._check_revision(expected_revision)
            value = self._overrides.get(field)
            if not isinstance(value, str) or not value:
                raise ValueError("该凭据来自 .env 或尚未通过浏览器保存，不能查看")
            return value

    def prepare(
        self,
        values: dict[str, Any],
        *,
        expected_revision: int,
        remove: Iterable[str] = (),
    ) -> tuple[dict[str, Any], Settings]:
        with self._lock:
            self._check_revision(expected_revision)
            candidate = dict(self._overrides)
            for field in remove:
                candidate.pop(field, None)
            candidate.update(values)
            return candidate, self._build(candidate)

    def commit(self, candidate: dict[str, Any], *, expected_revision: int) -> Settings:
        with self._lock:
            self._check_revision(expected_revision)
            updated = self._build(candidate)
            revision = self._revision + 1
            payload = {"revision": revision, "overrides": candidate}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_name(f".{self.path.name}.tmp")
            try:
                with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
                    json.dump(payload, handle, ensure_ascii=False, indent=2)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            finally:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
            self._overrides = candidate
            self._revision = revision
            self._current = updated
            return updated

    def _check_revision(self, expected: int) -> None:
        if expected != self._revision:
            raise SettingsRevisionConflictError(
                "配置已在其他页面更新，请刷新后重试"
            )

    def _build(self, overrides: dict[str, Any]) -> Settings:
        values = self._base.model_dump()
        values.update(overrides)
        return Settings(_env_file=None, **values)

    @classmethod
    def _allowed_fields(cls) -> set[str]:
        return {
            field for fields in cls.PROVIDER_FIELDS.values() for field in fields
        } | set(cls.DEFAULT_FIELDS) | set(cls.RUNTIME_FIELDS) | set(cls.WECHAT_FIELDS)

    def _load(self) -> None:
        if not self.path.is_file():
            return
        data = json.loads(self.path.read_text(encoding="utf-8"))
        revision = data.get("revision", 0)
        overrides = data.get("overrides", {})
        if not isinstance(revision, int) or revision < 0 or not isinstance(overrides, dict):
            raise ValueError("settings.json 格式非法")
        if unknown := set(overrides) - self._allowed_fields():
            raise ValueError(
                f"settings.json 包含不支持字段: {', '.join(sorted(unknown))}"
            )
        self._revision = revision
        self._overrides = overrides

    @staticmethod
    def _plain_value(value: Any) -> str:
        getter = getattr(value, "get_secret_value", None)
        return getter() if callable(getter) else str(value or "")
