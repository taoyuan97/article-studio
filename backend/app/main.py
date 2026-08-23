from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi import FastAPI, HTTPException, Query, Request, status
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from article_agent.agent import ArticleAgent
from article_agent.callbacks import build_callbacks
from article_agent.config import Settings
from article_agent.image_providers import ImageProviderRegistry
from article_agent.registry import ModelRegistry

from .database import NotFoundError, Repository, RunNotActiveError
from .image_service import ImageRunManager
from .service import RunManager


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=100_000)


class ModelUpdate(BaseModel):
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)


class ImageSessionCreate(BaseModel):
    article_id: str | None = None


class ImageMessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=100_000)
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)
    tier: str | None = Field(default=None, min_length=1)
    ratio: str | None = Field(default=None, min_length=1)


class AssetCreate(BaseModel):
    source_session_id: str = Field(min_length=1)
    source_message_id: str = Field(min_length=1)
    title: str = Field(min_length=0, max_length=200)


def _error(code: str, message: str, http_status: int) -> HTTPException:
    return HTTPException(
        status_code=http_status, detail={"code": code, "message": message}
    )


class SPAStaticFiles(StaticFiles):
    """Static files with SPA fallback: unknown non-API paths serve index.html.

    Unknown /api paths keep their 404 so the API surface stays observable.
    """

    async def get_response(self, path: str, scope):
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or path.startswith("api"):
                raise
            return await super().get_response("index.html", scope)
        if response.status_code == 404 and not path.startswith("api"):
            response = await super().get_response("index.html", scope)
        return response


def _setup_logging(data_dir: Path) -> None:
    """Configure application logging to a rotating file under data_dir/logs."""

    log_dir = data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "app.log"

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=10 * 1024 * 1024,  # 10 MB
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    root = logging.getLogger()
    # Avoid duplicate handlers if create_app is called multiple times in tests.
    if not any(isinstance(h, RotatingFileHandler) for h in root.handlers):
        root.addHandler(file_handler)
    root.setLevel(logging.INFO)


def create_app(
    *,
    settings: Settings | None = None,
    registry: ModelRegistry | None = None,
    image_registry_override: ImageProviderRegistry | None = None,
    data_dir: Path | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        resolved_settings = settings or Settings()
        resolved_registry = registry or ModelRegistry.from_settings(resolved_settings)
        resolved_data_dir = Path(data_dir or resolved_settings.data_dir).resolve()
        resolved_data_dir.mkdir(parents=True, exist_ok=True)
        _setup_logging(resolved_data_dir)
        repository = Repository(resolved_data_dir / "article.sqlite3")
        repository.initialize()
        repository.recover_stale_runs()

        checkpoint_connection = await aiosqlite.connect(
            resolved_data_dir / "checkpoints.sqlite3"
        )
        checkpointer = AsyncSqliteSaver(checkpoint_connection)
        await checkpointer.setup()
        agent = ArticleAgent(
            resolved_registry,
            usage_ratio=resolved_settings.llm_context_usage_ratio,
            recent_message_limit=resolved_settings.llm_recent_message_limit,
            callbacks=build_callbacks(resolved_settings),
            checkpointer=checkpointer,
        )
        secrets = [
            value.get_secret_value()
            for value in (
                resolved_settings.deepseek_api_key,
                resolved_settings.moonshot_api_key,
                resolved_settings.langsmith_api_key,
            )
            if value
        ]
        image_secrets = [
            value.get_secret_value()
            for value in (
                resolved_settings.aliyun_wanxiang_api_key,
                resolved_settings.dreamina_api_key,
            )
            if value
        ]
        manager = RunManager(repository, agent, secret_values=secrets)
        resolved_image_registry = image_registry_override or ImageProviderRegistry.from_settings(
            resolved_settings, data_dir=resolved_data_dir
        )
        image_manager = ImageRunManager(
            repository, resolved_image_registry, secret_values=secrets + image_secrets
        )
        application.state.settings = resolved_settings
        application.state.registry = resolved_registry
        application.state.image_registry = resolved_image_registry
        application.state.repository = repository
        application.state.manager = manager
        application.state.image_manager = image_manager
        (resolved_data_dir / "assets").mkdir(parents=True, exist_ok=True)
        application.mount(
            "/static/assets",
            StaticFiles(directory=resolved_data_dir / "assets"),
            name="assets",
        )
        if resolved_settings.serve_frontend:
            # Production mode: host the built SPA. Mounted last so all /api
            # routes (registered at create_app time) take precedence.
            dist_dir = Path(__file__).resolve().parents[2] / "frontend" / "dist"
            if dist_dir.is_dir():
                application.mount(
                    "/", SPAStaticFiles(directory=dist_dir, html=True), name="frontend"
                )
            else:
                logging.getLogger(__name__).warning(
                    "SERVE_FRONTEND=true but %s does not exist; "
                    "run `pnpm build` in frontend/ first. Skipping static hosting.",
                    dist_dir,
                )
        try:
            yield
        finally:
            await manager.shutdown()
            await image_manager.shutdown()
            await checkpoint_connection.close()

    application = FastAPI(title="Article Agent MVP", version="0.2.0", lifespan=lifespan)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @application.exception_handler(NotFoundError)
    async def handle_not_found(_request: Request, exc: NotFoundError):
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": str(exc)}},
        )

    @application.exception_handler(RunNotActiveError)
    async def handle_run_conflict(_request: Request, exc: RunNotActiveError):
        from fastapi.responses import JSONResponse

        code = "ARTICLE_RUN_ACTIVE" if str(exc) == "ARTICLE_RUN_ACTIVE" else "RUN_NOT_ACTIVE"
        return JSONResponse(
            status_code=409,
            content={"error": {"code": code, "message": str(exc)}},
        )

    @application.exception_handler(HTTPException)
    async def handle_http_error(request: Request, exc: HTTPException):
        from fastapi.responses import JSONResponse

        if isinstance(exc.detail, dict) and "code" in exc.detail:
            return JSONResponse(
                status_code=exc.status_code,
                content={"error": exc.detail},
                headers=exc.headers,
            )
        return await http_exception_handler(request, exc)

    def repository(request: Request) -> Repository:
        return request.app.state.repository

    def manager(request: Request) -> RunManager:
        return request.app.state.manager

    def image_registry(request: Request) -> ImageProviderRegistry:
        return request.app.state.image_registry

    def image_manager(request: Request) -> ImageRunManager:
        return request.app.state.image_manager

    def enrich_article(request: Request, article: dict[str, Any]) -> dict[str, Any]:
        return {
            **article,
            "has_active_run": manager(request).is_active(article["id"]),
        }

    def unavailable_models(request: Request) -> list[dict[str, str]]:
        configured = {
            item["provider"] for item in request.app.state.registry.list_models()
        }
        required = {
            "deepseek": "DEEPSEEK_API_KEY、DEEPSEEK_MODEL、DEEPSEEK_CONTEXT_WINDOW",
            "moonshot": "MOONSHOT_API_KEY、MOONSHOT_MODEL、MOONSHOT_CONTEXT_WINDOW",
        }
        return [
            {"provider": provider, "reason": f"需要配置 {variables}"}
            for provider, variables in required.items()
            if provider not in configured
        ]

    @application.post("/api/articles", status_code=status.HTTP_201_CREATED)
    async def create_article(request: Request):
        settings_value: Settings = request.app.state.settings
        provider_config = settings_value.provider(settings_value.default_llm_provider)
        article = repository(request).create_article(
            settings_value.default_llm_provider, provider_config.model or ""
        )
        return enrich_article(request, article)

    @application.get("/api/articles")
    async def list_articles(
        request: Request, limit: int = Query(default=100, ge=1, le=100)
    ):
        return {
            "items": [
                enrich_article(request, article)
                for article in repository(request).list_articles(limit)
            ]
        }

    @application.get("/api/articles/{article_id}")
    async def get_article(article_id: str, request: Request):
        return enrich_article(request, repository(request).get_article(article_id))

    @application.get("/api/stats")
    async def get_stats(request: Request):
        return repository(request).get_stats()

    @application.get("/api/health")
    async def health_check():
        return {"status": "ok"}

    @application.get("/api/articles/{article_id}/workspace")
    async def get_workspace(article_id: str, request: Request):
        result = repository(request).workspace(article_id)
        result["article"] = enrich_article(request, result["article"])
        result["conversation_id"] = result["article"]["conversation_id"]
        result["thread_id"] = result["article"]["thread_id"]
        result["active_run_id"] = manager(request).active_run_id(article_id)
        result["available_models"] = request.app.state.registry.list_models()
        result["unavailable_models"] = unavailable_models(request)
        return result

    @application.patch("/api/articles/{article_id}/model")
    async def update_model(article_id: str, payload: ModelUpdate, request: Request):
        if manager(request).is_active(article_id):
            raise RunNotActiveError("ARTICLE_RUN_ACTIVE")
        try:
            request.app.state.registry.get_capabilities(payload.provider, payload.model)
        except ValueError as exc:
            raise _error("MODEL_NOT_CONFIGURED", str(exc), 422) from exc
        return enrich_article(
            request,
            repository(request).update_model(article_id, payload.provider, payload.model),
        )

    @application.get("/api/articles/{article_id}/messages")
    async def list_messages(
        article_id: str,
        request: Request,
        before: str | None = None,
        limit: int = Query(default=100, ge=1, le=500),
    ):
        items = repository(request).list_messages(
            article_id, before=before, limit=limit
        )
        return {
            "items": items,
            "next_cursor": items[0]["id"] if len(items) == limit else None,
        }

    def run_response(run: dict[str, Any]) -> dict[str, Any]:
        return {
            "run_id": run["id"],
            "article_id": run["article_id"],
            "user_message_id": run["user_message_id"],
            "status": run["status"],
            "events_url": f"/api/runs/{run['id']}/events",
        }

    @application.post(
        "/api/articles/{article_id}/messages", status_code=status.HTTP_202_ACCEPTED
    )
    async def post_message(article_id: str, payload: MessageCreate, request: Request):
        run = await manager(request).start(article_id, content=payload.content)
        return run_response(run)

    @application.post(
        "/api/articles/{article_id}/messages/{message_id}/retry",
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def retry_message(article_id: str, message_id: str, request: Request):
        run = await manager(request).start(
            article_id, retry_message_id=message_id
        )
        return run_response(run)

    @application.get("/api/articles/{article_id}/versions")
    async def list_versions(article_id: str, request: Request):
        return {"items": repository(request).list_versions(article_id)}

    @application.get("/api/articles/{article_id}/versions/{version_id}")
    async def get_version(article_id: str, version_id: str, request: Request):
        return repository(request).get_version(article_id, version_id)

    @application.get("/api/runs/{run_id}/events")
    async def run_events(run_id: str, request: Request):
        async def stream():
            async for event in manager(request).events(run_id):
                payload = json.dumps(event.data, ensure_ascii=False, separators=(",", ":"))
                yield f"event: {event.type}\ndata: {payload}\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @application.post("/api/runs/{run_id}/cancel")
    async def cancel_run(run_id: str, request: Request):
        changed = await manager(request).cancel(run_id)
        return {"run_id": run_id, "cancelled": changed}

    def image_run_response(run: dict[str, Any]) -> dict[str, Any]:
        return {
            "run_id": run["id"],
            "session_id": run["session_id"],
            "user_message_id": run["user_message_id"],
            "status": run["status"],
            "events_url": f"/api/image-runs/{run['id']}/events",
        }

    @application.post("/api/image-sessions")
    async def create_image_session(
        payload: ImageSessionCreate,
        request: Request,
    ):
        settings_value: Settings = request.app.state.settings
        registry = request.app.state.image_registry
        providers = registry.list()
        if not providers:
            raise _error(
                "IMAGE_PROVIDER_NOT_CONFIGURED",
                "未配置可用的生图模型，请检查环境变量。",
                422,
            )
        provider = settings_value.default_image_provider
        if provider is None or provider not in {item["provider"] for item in providers}:
            provider = providers[0]["provider"]
        model = next(item["model"] for item in providers if item["provider"] == provider)
        return repository(request).create_image_session(
            provider=provider,
            model=model,
            article_id=payload.article_id,
        )

    @application.get("/api/image-sessions")
    async def list_image_sessions(
        request: Request, limit: int = Query(default=100, ge=1, le=100)
    ):
        return {"items": repository(request).list_image_sessions(limit)}

    @application.get("/api/image-sessions/{session_id}/workspace")
    async def get_image_workspace(session_id: str, request: Request):
        result = repository(request).image_workspace(session_id)
        result["available_providers"] = request.app.state.image_registry.list()
        result["active_run_id"] = image_manager(request).active_run_id(session_id)
        return result

    @application.post(
        "/api/image-sessions/{session_id}/messages", status_code=status.HTTP_202_ACCEPTED
    )
    async def post_image_message(
        session_id: str, payload: ImageMessageCreate, request: Request
    ):
        try:
            request.app.state.image_registry.get(payload.provider)
        except ValueError as exc:
            raise _error("IMAGE_PROVIDER_NOT_CONFIGURED", str(exc), 422) from exc
        run = await image_manager(request).start(
            session_id,
            content=payload.content,
            provider=payload.provider,
            model=payload.model,
            tier=payload.tier,
            ratio=payload.ratio,
        )
        return image_run_response(run)

    @application.get("/api/image-runs/{run_id}/events")
    async def image_run_events(run_id: str, request: Request):
        async def stream():
            async for event in image_manager(request).events(run_id):
                payload = json.dumps(event.data, ensure_ascii=False, separators=(",", ":"))
                yield f"event: {event.type}\ndata: {payload}\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @application.post("/api/image-runs/{run_id}/cancel")
    async def cancel_image_run(run_id: str, request: Request):
        changed = await image_manager(request).cancel(run_id)
        return {"run_id": run_id, "cancelled": changed}

    @application.post("/api/assets")
    async def create_asset(payload: AssetCreate, request: Request):
        try:
            asset = repository(request).create_asset(
                source_session_id=payload.source_session_id,
                source_message_id=payload.source_message_id,
                title=payload.title,
            )
        except ValueError as exc:
            raise _error("INVALID_ASSET_SOURCE", str(exc), 422) from exc
        return asset

    @application.get("/api/assets")
    async def list_assets(
        request: Request,
        kind: str | None = Query(default="image"),
        limit: int = Query(default=100, ge=1, le=100),
    ):
        return {"items": repository(request).list_assets(kind=kind, limit=limit)}

    @application.get("/api/assets/{asset_id}")
    async def get_asset(asset_id: str, request: Request):
        return repository(request).get_asset(asset_id)

    return application


app = create_app()
