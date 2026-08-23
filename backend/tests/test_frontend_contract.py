"""Frontend contract tests for the React SPA (frontend/).

The MVP validated the vanilla-JS frontend; the formal project rewrites it in
React. This suite keeps the same contract intent against the React sources:
- required scaffolding / API / SSE / component files exist;
- dynamic rendering never uses unsafe HTML injection;
- every backend API path and SSE event name stays wired in the API layer.
"""

from __future__ import annotations

from pathlib import Path


FRONTEND = Path(__file__).parents[2] / "frontend"
SRC = FRONTEND / "src"


def read(relative: str) -> str:
    return (FRONTEND / relative).read_text(encoding="utf-8")


def test_required_frontend_files_exist():
    required = {
        "package.json",
        "pnpm-lock.yaml",
        "vite.config.ts",
        "tsconfig.json",
        "index.html",
        "src/main.tsx",
        "src/App.tsx",
        "src/api/client.ts",
        "src/api/types.ts",
        "src/api/articles.ts",
        "src/api/imageSessions.ts",
        "src/api/assets.ts",
        "src/lib/queryClient.ts",
        "src/lib/sse.ts",
        "src/layouts/AppLayout.tsx",
        "src/components/MarkdownView.tsx",
        "src/components/StatusBanner.tsx",
    }
    assert all((FRONTEND / path).is_file() for path in required), sorted(
        path for path in required if not (FRONTEND / path).is_file()
    )


def test_dynamic_content_uses_safe_dom_apis():
    sources = "\n".join(
        path.read_text(encoding="utf-8") for path in SRC.rglob("*.tsx")
    ) + "\n".join(path.read_text(encoding="utf-8") for path in SRC.rglob("*.ts"))
    assert "dangerouslySetInnerHTML" not in sources
    assert "innerHTML" not in sources
    assert "rehype-raw" not in sources


def test_vite_proxy_targets_backend():
    config = read("vite.config.ts")
    assert "'/api'" in config
    assert "http://127.0.0.1:8000" in config
    assert "changeOrigin: true" in config


def test_api_and_sse_contract_is_wired():
    client = read("src/api/client.ts")
    articles = read("src/api/articles.ts")
    image_sessions = read("src/api/imageSessions.ts")
    assets = read("src/api/assets.ts")
    api_sources = client + articles + image_sessions + assets
    for path in (
        "/api/health",
        "/api/stats",
        "/api/articles",
        "/api/image-sessions",
        "/api/image-runs/",
        "/api/assets",
        "/workspace",
        "/messages",
        "/retry",
        "/versions",
        "/cancel",
        "/events",
    ):
        assert path in api_sources, path
    # Error normalisation contract.
    assert "BACKEND_UNREACHABLE" in client
    assert "ApiError" in client

    sse = read("src/lib/sse.ts")
    for event in (
        "run.started",
        "assistant.delta",
        "article.delta",
        "message.completed",
        "article.completed",
        "run.cancelled",
        "run.failed",
        "run.completed",
    ):
        assert event in sse, event
    for event in (
        "run.started",
        "image.progress",
        "image.completed",
        "image.failed",
        "run.cancelled",
        "run.completed",
    ):
        assert event in sse, event


def test_sse_stream_hooks_exist():
    hooks = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (SRC / "hooks").glob("*.ts")
    )
    assert "useArticleRunStream" in hooks
    assert "useImageRunStream" in hooks


def test_markdown_view_uses_sanitizer():
    markdown_view = read("src/components/MarkdownView.tsx")
    assert "react-markdown" in markdown_view
    assert "rehype-sanitize" in markdown_view


def test_image_params_contract():
    api_sources = read("src/api/imageSessions.ts")
    assert "tier" in api_sources
    assert "ratio" in api_sources
