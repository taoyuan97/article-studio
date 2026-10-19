from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from article_agent.agent import ArticleAgent
from article_agent.callbacks import build_callbacks
from article_agent.config import Settings
from article_agent.image_providers import ImageProviderRegistry, resolve_image_size
from article_agent.registry import ModelRegistry

from .mcp.constants import MCP_TOOL_COUNT
from .security import redact_sensitive, require_local_origin
from .settings_store import SettingsRevisionConflictError, SettingsStore
from .wenyan_client import WenyanMcpClient


def _disable_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(
    prefix="/api/settings", tags=["settings"], dependencies=[Depends(_disable_cache)]
)

PROVIDER_FIELD_MAP: dict[str, dict[str, str]] = {
    "llm_deepseek": {
        "credential": "deepseek_api_key",
        "base_url": "deepseek_base_url",
        "model_id": "deepseek_model",
        "context_window": "deepseek_context_window",
    },
    "llm_moonshot": {
        "credential": "moonshot_api_key",
        "base_url": "moonshot_base_url",
        "model_id": "moonshot_model",
        "context_window": "moonshot_context_window",
    },
    "image_wanxiang": {
        "credential": "aliyun_wanxiang_api_key",
        "base_url": "aliyun_wanxiang_base_url",
        "model_id": "aliyun_wanxiang_model",
    },
}


class ProviderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=0)
    credential: str | None = None
    base_url: str | None = None
    model_id: str | None = None
    context_window: int | None = Field(default=None, gt=0)


class RevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=0)


class CredentialRevealRequest(RevisionRequest):
    field: Literal["credential"]


class WechatCredentialRevealRequest(RevisionRequest):
    field: Literal["app_id", "app_secret"]


class DefaultsUpdate(RevisionRequest):
    default_llm_provider: Literal["deepseek", "moonshot"] | None = None
    default_image_provider: Literal["aliyun_wanxiang"] | None = None


class RuntimeUpdate(RevisionRequest):
    llm_timeout_seconds: float | None = Field(default=None, gt=0, le=600)
    llm_max_retries: int | None = Field(default=None, ge=0, le=10)
    llm_max_output_tokens: int | None = Field(default=None, gt=0, le=1_000_000)
    llm_context_usage_ratio: float | None = Field(default=None, gt=0, le=0.80)
    llm_recent_message_limit: int | None = Field(default=None, gt=0, le=10_000)
    image_timeout_seconds: float | None = Field(default=None, gt=0, le=1200)


class WechatUpdate(RevisionRequest):
    app_id: str | None = None
    app_secret: str | None = None


class McpUpdate(RevisionRequest):
    enabled: bool | None = None
    auth_enabled: bool | None = None
    auth_token: str | None = None
    allowed_hosts: list[str] | None = None
    wait_timeout_seconds: float | None = Field(default=None, gt=0, le=600)


class McpCredentialRevealRequest(RevisionRequest):
    field: Literal["auth_token"] = "auth_token"


def _store(request: Request) -> SettingsStore:
    return request.app.state.settings_store


def _plain(value: Any) -> str:
    getter = getattr(value, "get_secret_value", None)
    return getter() if callable(getter) else str(value or "")


def _mask(value: str) -> str | None:
    if not value:
        return None
    if len(value) <= 4:
        return f"{value[:1]}***"
    return f"{value[:3]}***{value[-4:]}"


def _provider_status(store: SettingsStore, provider: str) -> dict[str, Any]:
    settings = store.current
    if provider == "image_dreamina":
        return {
            "configured": False,
            "editable": False,
            "credential_masked": None,
            "credential_source": None,
            "runtime_credential_fields": [],
            "unavailable_reason": "敬请期待",
        }
    mapping = PROVIDER_FIELD_MAP[provider]
    credential = _plain(getattr(settings, mapping["credential"]))
    result: dict[str, Any] = {
        "configured": bool(credential),
        "editable": True,
        "credential_masked": _mask(credential),
        "credential_source": store.credential_source(provider),
        "runtime_credential_fields": (
            ["credential"] if store.has_override(mapping["credential"]) else []
        ),
        "base_url": getattr(settings, mapping["base_url"]),
        "model_id": getattr(settings, mapping["model_id"]),
    }
    if "context_window" in mapping:
        result["context_window"] = getattr(settings, mapping["context_window"])
    required = [credential, result.get("base_url"), result.get("model_id")]
    if "context_window" in mapping:
        required.append(result.get("context_window"))
    result["configured"] = all(bool(value) for value in required)
    return result


def _wechat_status(store: SettingsStore, request: Request) -> dict[str, Any]:
    settings = store.current
    app_id = settings.wechat_app_id
    app_secret = settings.wechat_app_secret
    client = WenyanMcpClient(settings, data_dir=request.app.state.data_dir)
    executable: str | None = None
    available = False
    try:
        command, _ = client._server_command()
        executable = Path(command).name
        available = True
    except Exception:
        pass
    runtime_fields = []
    if store.has_override("wechat_app_id"):
        runtime_fields.append("app_id")
    if store.has_override("wechat_app_secret"):
        runtime_fields.append("app_secret")
    masks = [item for item in (_mask(app_id), _mask(app_secret)) if item]
    return {
        "configured": bool(app_id and app_secret),
        "credential_masked": " / ".join(masks) or None,
        "credential_source": store.credential_source("wechat"),
        "runtime_credential_fields": runtime_fields,
        "mcp_command_configured": bool(settings.wenyan_mcp_command.strip()),
        "mcp_available": available,
        "mcp_executable": executable,
        "publish_fake_mode": settings.publish_fake_mode,
    }


_MCP_HOST_PATTERN = re.compile(r"^[a-z0-9.\-:\[\]]+$")


def _validate_mcp_hosts(values: list[str]) -> list[str]:
    """Validate the exact-hostname allowlist (ports ignored, no wildcards)."""

    hosts: list[str] = []
    for raw in values:
        host = str(raw).strip().lower()
        if not host:
            continue
        if len(host) > 253 or not _MCP_HOST_PATTERN.match(host):
            raise ValueError(f"MCP_ALLOWED_HOSTS 包含非法主机名：{raw}")
        if host in {"*", "0.0.0.0", "::"}:
            raise ValueError(f"MCP_ALLOWED_HOSTS 不支持该主机名：{raw}")
        if host not in hosts:
            hosts.append(host)
    if not hosts:
        raise ValueError("MCP_ALLOWED_HOSTS 不能为空；恢复默认请使用默认值")
    if len(hosts) > 20:
        raise ValueError("MCP_ALLOWED_HOSTS 最多 20 条")
    return hosts


def _mcp_status(store: SettingsStore, request: Request) -> dict[str, Any]:
    settings = store.current
    token = settings.mcp_auth_token
    token_value = token.get_secret_value() if token is not None else ""
    hosts = [
        item.strip()
        for item in settings.mcp_allowed_hosts.split(",")
        if item.strip()
    ]
    auth_runtime = store.has_override("mcp_auth_enabled") or store.has_override(
        "mcp_auth_token"
    )
    return {
        "enabled": settings.mcp_enabled,
        "enabled_source": (
            "runtime" if store.has_override("mcp_enabled") else "env"
        ),
        "endpoint": str(request.base_url).rstrip("/") + "/mcp/",
        "transport": "streamable-http",
        "tool_count": MCP_TOOL_COUNT,
        "auth": {
            "enabled": bool(settings.mcp_auth_enabled),
            "enabled_source": "runtime" if auth_runtime else "env",
            "token_masked": _mask(token_value) if token_value else None,
            "token_source": store.credential_source("mcp"),
            "runtime_token": store.has_override("mcp_auth_token"),
        },
        "allowed_hosts": hosts,
        "allowed_hosts_source": (
            "runtime" if store.has_override("mcp_allowed_hosts") else "env"
        ),
        "wait_timeout_seconds": settings.mcp_wait_timeout_seconds,
        "wait_timeout_source": (
            "runtime"
            if store.has_override("mcp_wait_timeout_seconds")
            else "env"
        ),
    }


def status_payload(request: Request) -> dict[str, Any]:
    store = _store(request)
    settings = store.current
    return {
        "revision": store.revision,
        "default_llm_provider": settings.default_llm_provider,
        "default_image_provider": settings.default_image_provider,
        "providers": {
            provider: _provider_status(store, provider)
            for provider in (
                "llm_deepseek",
                "llm_moonshot",
                "image_wanxiang",
                "image_dreamina",
            )
        },
        "runtime": {
            field: getattr(settings, field) for field in SettingsStore.RUNTIME_FIELDS
        },
        "wechat": _wechat_status(store, request),
        "mcp": _mcp_status(store, request),
    }


def _settings_error(exc: Exception) -> HTTPException:
    if isinstance(exc, SettingsRevisionConflictError):
        return HTTPException(
            409,
            detail={"code": "SETTINGS_REVISION_CONFLICT", "message": str(exc)},
            headers={"Cache-Control": "no-store"},
        )
    if isinstance(exc, OSError):
        return HTTPException(
            500,
            detail={
                "code": "SETTINGS_PERSIST_FAILED",
                "message": "配置保存失败，请检查数据目录权限",
            },
            headers={"Cache-Control": "no-store"},
        )
    return HTTPException(
        422,
        detail={"code": "SETTINGS_PARAMS_INVALID", "message": str(exc)},
        headers={"Cache-Control": "no-store"},
    )


def _validate_url(value: str) -> str:
    value = value.strip()
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Base URL 必须是完整的 HTTP(S) 地址")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError("Base URL 不能包含凭据或 fragment")
    return value.rstrip("/")


def _validate_defaults(settings: Settings, *, validate_image: bool = True) -> None:
    llm = settings.provider(settings.default_llm_provider)
    if not (
        llm.api_key
        and llm.api_key.get_secret_value()
        and llm.base_url
        and llm.model
        and llm.context_window
    ):
        raise ValueError("默认语言模型必须已完整配置")
    if validate_image and settings.default_image_provider:
        image = settings.image_provider(settings.default_image_provider)
        if settings.default_image_provider != "aliyun_wanxiang" or not (
            image.api_key
            and image.api_key.get_secret_value()
            and image.base_url
            and image.model
        ):
            raise ValueError("默认生图模型必须是已完整配置的通义万相")


def _all_secrets(settings: Settings) -> list[str]:
    return [
        _plain(value)
        for value in (
            settings.deepseek_api_key,
            settings.moonshot_api_key,
            settings.langsmith_api_key,
            settings.aliyun_wanxiang_api_key,
            settings.dreamina_api_key,
            settings.wechat_app_id,
            settings.wechat_app_secret,
            settings.mcp_auth_token,
        )
        if _plain(value)
    ]


def _runtime_bundle(request: Request, settings: Settings):
    registry = ModelRegistry.from_settings(settings)
    image_registry = ImageProviderRegistry.from_settings(
        settings, data_dir=request.app.state.data_dir
    )
    agent = ArticleAgent(
        registry,
        usage_ratio=settings.llm_context_usage_ratio,
        recent_message_limit=settings.llm_recent_message_limit,
        callbacks=build_callbacks(settings),
        checkpointer=request.app.state.checkpointer,
    )
    secrets = _all_secrets(settings)
    return registry, image_registry, agent, secrets


async def _commit_model_change(
    request: Request,
    values: dict[str, Any],
    *,
    revision: int,
    remove: tuple[str, ...] = (),
) -> None:
    try:
        async with request.app.state.configuration_lock:
            manager = request.app.state.manager
            image_manager = request.app.state.image_manager
            if manager.has_active_runs() or image_manager.has_active_runs():
                raise HTTPException(
                    409,
                    detail={
                        "code": "SETTINGS_RUN_ACTIVE",
                        "message": "当前有生成任务运行，请等待完成或取消后再保存模型配置",
                    },
                    headers={"Cache-Control": "no-store"},
                )
            candidate, settings = _store(request).prepare(
                values, expected_revision=revision, remove=remove
            )
            _validate_defaults(
                settings,
                validate_image=(
                    "default_image_provider" in values
                    or any(field.startswith("aliyun_wanxiang_") for field in (*values, *remove))
                ),
            )
            registry, image_registry, agent, secrets = _runtime_bundle(request, settings)
            _store(request).commit(candidate, expected_revision=revision)
            manager.reconfigure(agent, secrets)
            image_manager.reconfigure(image_registry, secrets)
            request.app.state.settings = settings
            request.app.state.registry = registry
            request.app.state.image_registry = image_registry
            request.app.state.secret_values = secrets
    except HTTPException:
        raise
    except Exception as exc:
        raise _settings_error(exc) from None


async def _commit_wechat_change(
    request: Request,
    values: dict[str, Any],
    *,
    revision: int,
    remove: tuple[str, ...] = (),
) -> None:
    try:
        async with request.app.state.configuration_lock:
            candidate, settings = _store(request).prepare(
                values, expected_revision=revision, remove=remove
            )
            client = WenyanMcpClient(settings, data_dir=request.app.state.data_dir)
            _store(request).commit(candidate, expected_revision=revision)
            request.app.state.settings = settings
            request.app.state.wenyan_client = client
            secrets = _all_secrets(settings)
            request.app.state.secret_values = secrets
            request.app.state.manager.secret_values = secrets
            request.app.state.image_manager.secret_values = secrets
    except Exception as exc:
        raise _settings_error(exc) from None


async def _commit_mcp_change(
    request: Request,
    values: dict[str, Any],
    *,
    revision: int,
    remove: tuple[str, ...] = (),
) -> None:
    """Persist MCP overrides and hot-apply them (next /mcp request sees them).

    Unlike model settings this does not rebuild agents or block active runs:
    the guard reads ``app.state.settings`` per request, and MCP switches never
    interrupt an in-flight article/image run.
    """

    try:
        async with request.app.state.configuration_lock:
            candidate, settings = _store(request).prepare(
                values, expected_revision=revision, remove=remove
            )
            _store(request).commit(candidate, expected_revision=revision)
            request.app.state.settings = settings
            secrets = _all_secrets(settings)
            request.app.state.secret_values = secrets
            request.app.state.manager.secret_values = secrets
            request.app.state.image_manager.secret_values = secrets
    except Exception as exc:
        raise _settings_error(exc) from None


@router.get("/status")
def get_status(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return status_payload(request)


@router.patch("/providers/{provider}")
async def update_provider(provider: str, payload: ProviderUpdate, request: Request):
    require_local_origin(request)
    mapping = PROVIDER_FIELD_MAP.get(provider)
    if mapping is None:
        raise _settings_error(ValueError("该服务不支持页面编辑"))
    raw = payload.model_dump(exclude_none=True, exclude={"revision"})
    if unknown := set(raw) - set(mapping):
        raise _settings_error(ValueError(f"该服务不支持字段: {', '.join(sorted(unknown))}"))
    if not raw:
        raise _settings_error(ValueError("没有可更新的字段"))
    values: dict[str, Any] = {}
    for key, value in raw.items():
        if isinstance(value, str):
            value = value.strip()
            if not value:
                raise _settings_error(ValueError("配置值不能为空；清除凭据请使用清除操作"))
            if key == "base_url":
                value = _validate_url(value)
        values[mapping[key]] = value
    await _commit_model_change(request, values, revision=payload.revision)
    return {
        "revision": _store(request).revision,
        "provider": _provider_status(_store(request), provider),
    }


@router.delete("/providers/{provider}/credentials")
async def clear_provider_credentials(
    provider: str, payload: RevisionRequest, request: Request
):
    require_local_origin(request)
    mapping = PROVIDER_FIELD_MAP.get(provider)
    if mapping is None:
        raise _settings_error(ValueError("该服务不支持页面编辑"))
    await _commit_model_change(
        request,
        {},
        revision=payload.revision,
        remove=(mapping["credential"],),
    )
    return {
        "revision": _store(request).revision,
        "provider": _provider_status(_store(request), provider),
    }


@router.post("/providers/{provider}/credentials/reveal")
def reveal_provider_credential(
    provider: str,
    payload: CredentialRevealRequest,
    request: Request,
    response: Response,
):
    require_local_origin(request)
    mapping = PROVIDER_FIELD_MAP.get(provider)
    if mapping is None:
        raise _settings_error(ValueError("该服务不支持页面查看凭据"))
    try:
        value = _store(request).reveal_override(
            mapping["credential"], expected_revision=payload.revision
        )
    except Exception as exc:
        raise _settings_error(exc) from None
    response.headers["Cache-Control"] = "no-store"
    return {"revision": _store(request).revision, "field": payload.field, "value": value}


@router.patch("/defaults")
async def update_defaults(payload: DefaultsUpdate, request: Request):
    require_local_origin(request)
    values = payload.model_dump(exclude_none=True, exclude={"revision"})
    if not values:
        raise _settings_error(ValueError("没有可更新的默认模型"))
    await _commit_model_change(request, values, revision=payload.revision)
    return status_payload(request)


@router.patch("/runtime")
async def update_runtime(payload: RuntimeUpdate, request: Request):
    require_local_origin(request)
    values = payload.model_dump(exclude_none=True, exclude={"revision"})
    if not values:
        raise _settings_error(ValueError("没有可更新的运行参数"))
    await _commit_model_change(request, values, revision=payload.revision)
    return status_payload(request)


@router.patch("/wechat")
async def update_wechat(payload: WechatUpdate, request: Request):
    require_local_origin(request)
    raw = payload.model_dump(exclude_none=True, exclude={"revision"})
    if not raw:
        raise _settings_error(ValueError("没有可更新的公众号配置"))
    values = {}
    for field, value in raw.items():
        value = value.strip()
        if not value:
            raise _settings_error(ValueError("凭据不能为空；清除请使用清除操作"))
        values[{"app_id": "wechat_app_id", "app_secret": "wechat_app_secret"}[field]] = value
    await _commit_wechat_change(request, values, revision=payload.revision)
    return status_payload(request)


@router.delete("/wechat/credentials")
async def clear_wechat_credentials(
    payload: RevisionRequest, request: Request
):
    require_local_origin(request)
    await _commit_wechat_change(
        request,
        {},
        revision=payload.revision,
        remove=("wechat_app_id", "wechat_app_secret"),
    )
    return status_payload(request)


@router.post("/wechat/credentials/reveal")
def reveal_wechat_credential(
    payload: WechatCredentialRevealRequest,
    request: Request,
    response: Response,
):
    require_local_origin(request)
    field = {"app_id": "wechat_app_id", "app_secret": "wechat_app_secret"}[payload.field]
    try:
        value = _store(request).reveal_override(field, expected_revision=payload.revision)
    except Exception as exc:
        raise _settings_error(exc) from None
    response.headers["Cache-Control"] = "no-store"
    return {"revision": _store(request).revision, "field": payload.field, "value": value}


@router.patch("/mcp")
async def update_mcp(payload: McpUpdate, request: Request):
    require_local_origin(request)
    try:
        values: dict[str, Any] = {}
        if payload.enabled is not None:
            values["mcp_enabled"] = payload.enabled
        if payload.auth_enabled is not None:
            values["mcp_auth_enabled"] = payload.auth_enabled
        if payload.auth_token is not None:
            token = payload.auth_token.strip()
            if not token:
                raise ValueError(
                    "Token 不能为空；关闭鉴权请使用开关，清除请使用清除操作"
                )
            if len(token) > 256:
                raise ValueError("Token 长度不能超过 256")
            values["mcp_auth_token"] = token
            if payload.auth_enabled is None:
                # Supplying a token implies enabling auth unless explicitly told otherwise.
                values["mcp_auth_enabled"] = True
        if payload.allowed_hosts is not None:
            values["mcp_allowed_hosts"] = ",".join(
                _validate_mcp_hosts(payload.allowed_hosts)
            )
        if payload.wait_timeout_seconds is not None:
            values["mcp_wait_timeout_seconds"] = payload.wait_timeout_seconds
        if not values:
            raise ValueError("没有可更新的 MCP 配置")
    except ValueError as exc:
        raise _settings_error(exc) from None
    await _commit_mcp_change(request, values, revision=payload.revision)
    return status_payload(request)


@router.delete("/mcp/token")
async def clear_mcp_token(payload: RevisionRequest, request: Request):
    require_local_origin(request)
    await _commit_mcp_change(
        request, {}, revision=payload.revision, remove=("mcp_auth_token",)
    )
    return status_payload(request)


@router.post("/mcp/token/reveal")
def reveal_mcp_token(
    payload: McpCredentialRevealRequest,
    request: Request,
    response: Response,
):
    require_local_origin(request)
    try:
        value = _store(request).reveal_override(
            "mcp_auth_token", expected_revision=payload.revision
        )
    except Exception as exc:
        raise _settings_error(exc) from None
    response.headers["Cache-Control"] = "no-store"
    return {
        "revision": _store(request).revision,
        "field": payload.field,
        "value": value,
    }


@router.post("/probe/{provider}")
async def probe_provider(provider: str, request: Request):
    require_local_origin(request)
    if provider not in {
        "llm_deepseek",
        "llm_moonshot",
        "image_wanxiang",
        "wechat",
        "mcp",
    }:
        raise _settings_error(ValueError("未知或暂不支持的探测项"))
    started = time.perf_counter()
    try:
        if provider == "mcp":
            settings = _store(request).current
            if not settings.mcp_enabled:
                raise ValueError("MCP 未开启：保存开启后 /mcp 才可用")
            auth = (
                "Bearer 鉴权已启用"
                if settings.mcp_auth_enabled
                else "未启用鉴权（仅 Host 白名单）"
            )
            message = (
                f"MCP 配置就绪：{MCP_TOOL_COUNT} 个工具，{auth}"
                "（配置级检查，未发起网络请求）"
            )
        elif provider == "wechat":
            settings = _store(request).current
            if not settings.wechat_app_id or not settings.wechat_app_secret:
                raise ValueError("微信公众号 AppID 或 AppSecret 未配置")
            client = request.app.state.wenyan_client
            client._server_command()
            if settings.publish_fake_mode:
                message = "当前为假发布，已检查本地配置，未请求微信接口"
            else:
                await client.list_themes()
                message = "wenyan-mcp 响应成功"
        elif provider.startswith("llm_"):
            internal = "deepseek" if provider == "llm_deepseek" else "moonshot"
            config = _store(request).current.provider(internal)
            if not config.model:
                raise ValueError("模型 ID 未配置")
            model = request.app.state.registry.get_chat_model(internal, config.model)
            await asyncio.wait_for(model.ainvoke("请只回复：连接成功"), timeout=30)
            message = "模型响应成功"
        else:
            image_provider = request.app.state.image_registry.get("aliyun_wanxiang")
            result = await image_provider.generate(
                "极简蓝色圆点，纯白背景", size=resolve_image_size("aliyun_wanxiang", "1K", "1:1")
            )
            try:
                result.local_path.unlink(missing_ok=True)
            except OSError:
                pass
            message = "通义万相生图成功"
        return {
            "ok": True,
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "message": message,
        }
    except Exception as exc:
        detail = redact_sensitive(exc, request.app.state.secret_values)
        return {
            "ok": False,
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "message": detail[:200] or "连通测试失败",
        }
