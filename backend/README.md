# Article Studio Backend

正式项目后端，由 `prototype/article-agent-mvp/backend` 契约不变迁移而来：

- 包结构变化：`src/article_agent/` 合并为平级包 `article_agent/`，`app/` 原位；API 路径、请求/响应结构、SSE 事件协议与 MVP 完全一致。
- 新增 `SERVE_FRONTEND` 环境变量：生产模式由 FastAPI 托管 `../frontend/dist`（SPA fallback）；默认 `false`，行为与 MVP 一致。
- 不迁移 MVP 数据（`.venv`、`data/` 均从零开始）。

## 安装与测试

要求 Python 3.11+，使用 uv：

```powershell
uv sync
uv run pytest -p no:cacheprovider
```

复制 `.env.example` 为 `.env`，至少配置默认供应商的 API Key、模型 ID 与上下文窗口（离线测试不依赖真实密钥）。

## 启动 API（开发模式）

```powershell
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

- OpenAPI 文档：`http://127.0.0.1:8000/docs`
- 健康检查：`GET /api/health` → `{"status": "ok"}`
- 允许的浏览器来源：`http://localhost:5173` / `http://127.0.0.1:5173`（开发主路径走 Vite proxy，同源不触发 CORS）

数据默认写入本目录 `data/`（`article.sqlite3` 业务库、`checkpoints.sqlite3` checkpoint 库、`assets/` 图片文件），可通过 `DATA_DIR` 修改。

## 生产模式（单进程托管前端）

先构建前端产物，再以 `SERVE_FRONTEND=true` 启动：

```powershell
cd ..\frontend
pnpm build              # 产物 → frontend/dist

cd ..\backend
$env:SERVE_FRONTEND = "true"
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

行为说明：

- `SERVE_FRONTEND=false`（默认）：不读取 `frontend/dist`，与 MVP 完全一致。
- `SERVE_FRONTEND=true`：挂载静态资源；`/api` 路径优先匹配 API（未命中的 `/api` 路径返回 404）；其余未命中路径返回 `index.html`（SPA fallback，配合前端 BrowserRouter）。

## API 契约（与 MVP 一致）

```text
# 文章线
POST   /api/articles                          创建文章 → 201
GET    /api/articles?limit=100                文章列表
GET    /api/articles/{id}                     文章详情
GET    /api/stats                             统计
GET    /api/health                            健康检查
GET    /api/articles/{id}/workspace           工作台聚合
PATCH  /api/articles/{id}/model               切换模型（运行中 409）
GET    /api/articles/{id}/messages?before&limit
POST   /api/articles/{id}/messages            发送消息 → 202 + run
POST   /api/articles/{id}/messages/{mid}/retry
GET    /api/articles/{id}/versions
GET    /api/articles/{id}/versions/{vid}
GET    /api/runs/{run_id}/events              文章运行 SSE
POST   /api/runs/{run_id}/cancel

# 配图线
POST   /api/image-sessions
GET    /api/image-sessions
GET    /api/image-sessions/{id}/workspace
POST   /api/image-sessions/{id}/messages      → 202 + run
GET    /api/image-runs/{run_id}/events        配图运行 SSE
POST   /api/image-runs/{run_id}/cancel

# 素材线
POST   /api/assets
GET    /api/assets?kind=image&limit=100
GET    /api/assets/{id}
```

SSE 事件协议不变：文章线 8 种（`run.started`、`assistant.delta`、`article.delta`、`message.completed`、`article.completed`、`run.cancelled`、`run.failed`、`run.completed`）；配图线 6 种（`run.started`、`image.progress`、`image.completed`、`image.failed`、`run.cancelled`、`run.completed`）。契约基准见 `tests/test_frontend_contract.py`。

## 真实 API 冒烟（不进离线测试）

```powershell
uv run python scripts/smoke_models.py deepseek
uv run python scripts/smoke_models.py moonshot
uv run python scripts/test_real_image_providers.py
```

需要在 `.env` 配置对应供应商密钥。

## 假模型服务器（不消耗真实 API 额度）

```powershell
# 前端联调：假 LLM + 假生图，API/SSE/SQLite 行为与真实后端完全一致
uv run python scripts/dev_fake_server.py [--port 8000] [--data-dir data/dev-fake]

# E2E 专用：同上，但 SERVE_FRONTEND=true 单进程托管 frontend/dist（生产形态），--wipe 清空数据
.venv/Scripts/python.exe scripts/e2e_server.py --port 8901 --wipe
```

假模型行为约定（便于构造场景）：最新用户消息含「触发失败」→ 该次运行延迟 0.5s 后失败（错误详情含 SIMULATED_FAILURE）；生图提示词含「触发失败」→ 同样延迟 0.5s 后失败。触发词用「触发失败」而非「失败」，避免正文模板与压缩摘要中的「失败」字样误触发。数据写入独立目录，删除即可重置。

## 核心与持久化边界（迁移自 MVP，未改动）

- `ArticleAgent.stream()` 只发出 `assistant.delta`、`article.delta`、`result.ready`、`run.cancelled`、`run.failed`、`run.completed`；版本事务仅在 `result.ready` 后开启。
- 业务库 `article.sqlite3` 与 checkpoint 库 `checkpoints.sqlite3` 分离；checkpoint 缺失时从业务数据恢复并沿用原 `thread_id`。
- 80% 上下文预算、相关历史过滤、失败脱敏、同文章运行互斥、原消息重试均保持 MVP 行为。
